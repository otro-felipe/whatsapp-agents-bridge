import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError } from "./types.js";

// Windows chmod does not restrict other users. Install an exact, protected
// current-user DACL and verify it before callers write any private data. Existing
// children are hardened too: Windows users can bypass directory traversal checks.
// Paths travel on stdin, never inside PowerShell source or command arguments.
const windowsPrivateDirectoryScript = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding
  $root = [Console]::In.ReadToEnd()
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  function Protect-Path([string] $path) {
    $item = Get-Item -Force -LiteralPath $path
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'link' }
    if ($item.PSIsContainer) {
      $security = New-Object System.Security.AccessControl.DirectorySecurity
      $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
      $security = New-Object System.Security.AccessControl.FileSecurity
      $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $security.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inheritance, 'None', 'Allow')
    $security.AddAccessRule($rule)
    Set-Acl -LiteralPath $path -AclObject $security
    $actual = Get-Acl -LiteralPath $path
    $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if (!$actual.AreAccessRulesProtected -or $rules.Count -ne 1) { throw 'acl' }
    $actualRule = $rules[0]
    if ($actualRule.IdentityReference -ne $sid -or $actualRule.AccessControlType -ne 'Allow' -or $actualRule.FileSystemRights -ne 'FullControl' -or $actualRule.InheritanceFlags -ne $inheritance -or $actualRule.PropagationFlags -ne 'None') { throw 'acl' }
    if ($item.PSIsContainer) {
      foreach ($child in @(Get-ChildItem -Force -LiteralPath $path)) { Protect-Path $child.FullName }
    }
  }
  Protect-Path $root
  exit 0
} catch { exit 1 }
`;

/** The directory must be dedicated to bridge storage, never a shared folder. */
export function ensurePrivateDirectorySync(directory: string): void {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    if (process.platform !== "win32") {
      chmodSync(directory, 0o700);
      if ((lstatSync(directory).mode & 0o777) !== 0o700) throw new Error();
      return;
    }
    execFileSync(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsPrivateDirectoryScript, "utf16le").toString(
          "base64",
        ),
      ],
      {
        input: directory,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
        timeout: 30_000,
      },
    );
  } catch {
    throw new BridgeError("private_storage_permissions_failed", 500);
  }
}

export async function createPrivateTemporaryDirectory(
  prefix: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    ensurePrivateDirectorySync(directory);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
