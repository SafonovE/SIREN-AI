param(
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$ImagePath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Await-WinRt {
  param(
    [Parameter(Mandatory = $true)]$Operation,
    [Parameter(Mandatory = $true)][Type]$ResultType
  )

  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.IsGenericMethod -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.ExifOrientationMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.ColorManagementMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]

  $language = [Windows.Globalization.Language]::new('ru-RU')
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if ($null -eq $engine) {
    throw 'OCR language is unavailable.'
  }

  $items = @()
  foreach ($itemPath in $ImagePath) {
    if (-not [System.IO.Path]::IsPathRooted($itemPath) -or -not [System.IO.File]::Exists($itemPath)) {
      throw 'OCR input is unavailable.'
    }
    $stream = $null
    $bitmap = $null
    try {
      $file = Await-WinRt -Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($itemPath)) -ResultType ([Windows.Storage.StorageFile])
      $stream = Await-WinRt -Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) -ResultType ([Windows.Storage.Streams.IRandomAccessStream])
      $decoder = Await-WinRt -Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) -ResultType ([Windows.Graphics.Imaging.BitmapDecoder])
      # WinRT reports a generous formal maximum, but OCR is more reliable below ~1.5k px
      # on each side on supported Windows builds. Scale proportionally before recognition.
      $safeDimension = [Math]::Min([int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension, 1500)
      $width = [double]$decoder.PixelWidth
      $height = [double]$decoder.PixelHeight
      if ([Math]::Max($width, $height) -gt $safeDimension) {
        $scale = $safeDimension / [Math]::Max($width, $height)
        $transform = [Windows.Graphics.Imaging.BitmapTransform]::new()
        $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($width * $scale))
        $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($height * $scale))
        $bitmap = Await-WinRt -Operation ($decoder.GetSoftwareBitmapAsync(
          [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
          [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
          $transform,
          [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
          [Windows.Graphics.Imaging.ColorManagementMode]::ColorManageToSRgb
        )) -ResultType ([Windows.Graphics.Imaging.SoftwareBitmap])
      } else {
        $bitmap = Await-WinRt -Operation ($decoder.GetSoftwareBitmapAsync()) -ResultType ([Windows.Graphics.Imaging.SoftwareBitmap])
      }
      $result = Await-WinRt -Operation ($engine.RecognizeAsync($bitmap)) -ResultType ([Windows.Media.Ocr.OcrResult])
      $items += [pscustomobject]@{ ok = $true; text = [string]$result.Text }
    } finally {
      if ($null -ne $bitmap) { $bitmap.Dispose() }
      if ($null -ne $stream) { $stream.Dispose() }
    }
  }
  [Console]::Out.Write(([pscustomobject]@{ ok = $true; language = 'ru-RU'; results = $items } | ConvertTo-Json -Compress -Depth 4))
} catch {
  [Console]::Out.Write(([pscustomobject]@{ ok = $false; code = 'OCR_FAILED' } | ConvertTo-Json -Compress))
  exit 1
}
