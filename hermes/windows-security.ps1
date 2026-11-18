param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('ensure-directory', 'verify-directory', 'verify-key', 'secure-key')]
    [string] $Operation,

    [Parameter(Mandatory = $true, Position = 1)]
    [string] $Target
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Get-CurrentUserSid {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($null -eq $sid) { throw 'Current user SID is unavailable' }
    return $sid
}

function Get-TargetParts([string] $Path) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($root)) { throw 'Target path is not rooted' }
    $tail = $fullPath.Substring($root.Length)
    if ($tail.Contains(':')) { throw 'Alternate data stream paths are not supported' }
    $separators = [char[]] @([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $parts = @($tail.Split($separators, [System.StringSplitOptions]::RemoveEmptyEntries))
    return @{ FullPath = $fullPath; Root = $root; Parts = $parts }
}

function Get-ItemIfPresent([string] $Path) {
    if (Test-Path -LiteralPath $Path -PathType Any) {
        return Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    }
    return $null
}

function Assert-DirectoryItem($Item) {
    if ($null -eq $Item) { throw 'Directory does not exist' }
    if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not permitted' }
    if (-not $Item.PSIsContainer) { throw 'Path component is not a directory' }
}

function Assert-ParentHasNoUntrustedWriteAccess([string] $Path, $CurrentSid) {
    $acl = Get-Acl -LiteralPath $Path
    $trustedSid = @($CurrentSid.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-4')
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($trustedSid -notcontains $owner) { throw 'Parent directory has an untrusted owner' }
    $writeMask = [long] (
        [System.Security.AccessControl.FileSystemRights]::Write -bor
        [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor
        [System.Security.AccessControl.FileSystemRights]::CreateDirectories -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
    )
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
        if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if ($trustedSid -contains $rule.IdentityReference.Value) { continue }
        if (([long] $rule.FileSystemRights -band $writeMask) -ne 0) {
            throw 'Parent directory is writable by an untrusted identity'
        }
    }
}

function Set-PrivateDirectoryAcl([string] $Path, $CurrentSid) {
    $acl = Get-Acl -LiteralPath $Path
    # New directories inherit their parent's ACL. Protect this directory and
    # remove inherited and explicit entries before granting its current user.
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
        [void] $acl.RemoveAccessRuleSpecific($rule)
    }
    $acl.SetOwner($CurrentSid)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @(
        $CurrentSid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void] $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Set-PrivateKeyAcl([string] $Path, $CurrentSid) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not permitted' }
    if ($item.PSIsContainer) { throw 'Key path is a directory' }
    if ($item.Length -ne 0) { throw 'Only a newly created empty key file can be secured' }
    $parent = [System.IO.Path]::GetDirectoryName($Path)
    Assert-PrivateAcl $parent 'directory' $CurrentSid
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
        [void] $acl.RemoveAccessRuleSpecific($rule)
    }
    $acl.SetOwner($CurrentSid)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @(
        $CurrentSid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void] $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-PrivateAcl([string] $Path, [string] $Kind, $CurrentSid) {
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($owner.Value -ne $CurrentSid.Value) { throw 'Private path has the wrong owner' }
    if ($Kind -eq 'directory' -and -not $acl.AreAccessRulesProtected) { throw 'Private directory DACL is inheritable' }

    $rights = [long] 0
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($rules.Count -eq 0) { throw 'Private path DACL is empty' }
    foreach ($rule in $rules) {
        if ($rule.IdentityReference.Value -ne $CurrentSid.Value) { throw 'Private path DACL grants another identity' }
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw 'Private path DACL contains a deny rule' }
        $rights = $rights -bor [long] $rule.FileSystemRights
    }
    $required = [long] [System.Security.AccessControl.FileSystemRights]::FullControl
    if (($rights -band $required) -ne $required) { throw 'Private path owner lacks full control' }
}

try {
    $sid = Get-CurrentUserSid
    $pathParts = Get-TargetParts $Target
    $current = $pathParts.Root
    $lastIndex = $pathParts.Parts.Length - 1
    if ($lastIndex -lt 0) { throw 'A filesystem root cannot be a private channel directory or key' }

    for ($index = 0; $index -le $lastIndex; $index++) {
        $current = [System.IO.Path]::Combine($current, [string] $pathParts.Parts[$index])
        $isLeaf = $index -eq $lastIndex
        $item = Get-ItemIfPresent $current

        if ($null -eq $item) {
            if ($Operation -ne 'ensure-directory') { throw 'Private path does not exist' }
            if ($index -eq 0) { throw 'Private directory parent is unavailable' }
            $parent = [System.IO.Path]::GetDirectoryName($current)
            Assert-ParentHasNoUntrustedWriteAccess $parent $sid
            [void] [System.IO.Directory]::CreateDirectory($current)
            Set-PrivateDirectoryAcl $current $sid
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        }

        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not permitted' }
        if (-not $isLeaf) {
            Assert-DirectoryItem $item
            Assert-ParentHasNoUntrustedWriteAccess $current $sid
            continue
        }

        if ($Operation -eq 'secure-key') {
            if ($index -ne $lastIndex -or $item.PSIsContainer) { throw 'Key path must be a file in a secured directory' }
            $parent = [System.IO.Path]::GetDirectoryName($current)
            Assert-PrivateAcl $parent 'directory' $sid
            Set-PrivateKeyAcl $current $sid
            Assert-PrivateAcl $current 'key' $sid
        } elseif ($Operation -eq 'verify-key') {
            if ($item.PSIsContainer) { throw 'Key path is a directory' }
            Assert-PrivateAcl $current 'key' $sid
        } else {
            Assert-DirectoryItem $item
            Assert-PrivateAcl $current 'directory' $sid
        }
    }
    exit 0
} catch {
    $detail = $_.Exception.Message
    if ($detail.Length -gt 200 -or $detail.Contains(':\')) { $detail = 'The operating system rejected a filesystem security operation' }
    [Console]::Error.WriteLine("Windows private-path security check failed: $detail. Use an NTFS directory owned by the current user, with no untrusted write access in its parents.")
    exit 1
}
