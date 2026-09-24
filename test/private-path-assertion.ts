import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

/** Inspect permissions only; never read the artifact itself or emit identities. */
export function assertPrivatePath(path: string, directory = false) {
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, directory ? 0o700 : 0o600);
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  $path = $reader.ReadToEnd()
  if ([System.IO.Directory]::Exists($path)) {
    $acl = (New-Object System.IO.DirectoryInfo($path)).GetAccessControl()
  } else {
    $acl = (New-Object System.IO.FileInfo($path)).GetAccessControl()
  }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1) { exit 1 }
  $rule = $rules[0]
  if ($rule.IdentityReference -ne $sid -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { exit 1 }
  if ([System.IO.Directory]::Exists($path) -and (!$acl.AreAccessRulesProtected -or $rule.InheritanceFlags -ne 'ContainerInherit, ObjectInherit')) { exit 1 }
  exit 0
} catch { exit 1 }
`;
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
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { input: path, stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
  );
}
