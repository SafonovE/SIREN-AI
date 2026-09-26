param(
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$LiteralPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace SirenAI {
  public static class NativePath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetShortPathName(
      string longPath,
      StringBuilder shortPath,
      uint bufferLength
    );
  }
}
'@

  $paths = @()
  foreach ($itemPath in $LiteralPath) {
    if (-not [System.IO.Path]::IsPathRooted($itemPath) -or
        (-not [System.IO.File]::Exists($itemPath) -and -not [System.IO.Directory]::Exists($itemPath))) {
      throw 'Path is unavailable.'
    }

    $fullPath = [System.IO.Path]::GetFullPath($itemPath)
    $buffer = [System.Text.StringBuilder]::new(32768)
    $length = [SirenAI.NativePath]::GetShortPathName($fullPath, $buffer, [uint32]$buffer.Capacity)
    if ($length -gt 0 -and $length -lt $buffer.Capacity) {
      $paths += $buffer.ToString()
    } else {
      # 8.3 names may be disabled on a volume. The caller can still try the Unicode path.
      $paths += $fullPath
    }
  }

  [Console]::Out.Write(([pscustomobject]@{ ok = $true; paths = $paths } | ConvertTo-Json -Compress -Depth 3))
} catch {
  [Console]::Out.Write(([pscustomobject]@{ ok = $false; code = 'SHORT_PATH_FAILED' } | ConvertTo-Json -Compress))
  exit 1
}
