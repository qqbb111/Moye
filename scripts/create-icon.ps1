$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$rypotaAssetRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\assets'))
$rypotaBitmap = New-Object Drawing.Bitmap 256,256
$rypotaGraphics = [Drawing.Graphics]::FromImage($rypotaBitmap)
$rypotaGraphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$rypotaBackground = New-Object Drawing.Drawing2D.GraphicsPath
$rypotaBackground.AddArc(8,8,112,112,180,90)
$rypotaBackground.AddArc(136,8,112,112,270,90)
$rypotaBackground.AddArc(136,136,112,112,0,90)
$rypotaBackground.AddArc(8,136,112,112,90,90)
$rypotaBackground.CloseFigure()
$rypotaBrush = New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml('#7477ad'))
$rypotaGraphics.FillPath($rypotaBrush,$rypotaBackground)
$rypotaFeather = New-Object Drawing.Drawing2D.GraphicsPath
$rypotaFeather.AddBezier(206,51,164,36,120,58,101,102)
$rypotaFeather.AddLine(101,102,55,202)
$rypotaFeather.AddLine(55,202,132,159)
$rypotaFeather.AddBezier(132,159,183,131,211,90,206,51)
$rypotaFeather.CloseFigure()
$rypotaFill = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(43,255,255,255))
$rypotaPen = New-Object Drawing.Pen ([Drawing.Color]::White),9
$rypotaPen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
$rypotaPen.StartCap = [Drawing.Drawing2D.LineCap]::Round
$rypotaPen.EndCap = [Drawing.Drawing2D.LineCap]::Round
$rypotaGraphics.FillPath($rypotaFill,$rypotaFeather)
$rypotaGraphics.DrawPath($rypotaPen,$rypotaFeather)
$rypotaGraphics.DrawLine($rypotaPen,55,202,157,101)
$rypotaStream = New-Object IO.MemoryStream
$rypotaBitmap.Save($rypotaStream,[Drawing.Imaging.ImageFormat]::Png)
$rypotaPng = $rypotaStream.ToArray()
[IO.File]::WriteAllBytes((Join-Path $rypotaAssetRoot 'rypota.png'),$rypotaPng)
$rypotaIconStream = New-Object IO.MemoryStream
$rypotaWriter = New-Object IO.BinaryWriter $rypotaIconStream
$rypotaWriter.Write([uint16]0); $rypotaWriter.Write([uint16]1); $rypotaWriter.Write([uint16]1)
$rypotaWriter.Write([byte]0); $rypotaWriter.Write([byte]0); $rypotaWriter.Write([byte]0); $rypotaWriter.Write([byte]0)
$rypotaWriter.Write([uint16]1); $rypotaWriter.Write([uint16]32)
$rypotaWriter.Write([uint32]$rypotaPng.Length); $rypotaWriter.Write([uint32]22); $rypotaWriter.Write($rypotaPng)
[IO.File]::WriteAllBytes((Join-Path $rypotaAssetRoot 'rypota.ico'),$rypotaIconStream.ToArray())
$rypotaWriter.Dispose(); $rypotaIconStream.Dispose(); $rypotaStream.Dispose(); $rypotaPen.Dispose(); $rypotaFill.Dispose(); $rypotaFeather.Dispose(); $rypotaBrush.Dispose(); $rypotaBackground.Dispose(); $rypotaGraphics.Dispose(); $rypotaBitmap.Dispose()
