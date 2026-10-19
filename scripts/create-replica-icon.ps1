Add-Type -AssemblyName System.Drawing
$replicaBitmap = [System.Drawing.Bitmap]::new(256, 256)
$replicaGraphics = [System.Drawing.Graphics]::FromImage($replicaBitmap)
$replicaGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$replicaGraphics.Clear([System.Drawing.Color]::FromArgb(52, 61, 76))
$replicaPaper = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(250, 249, 246))
$replicaGraphics.FillRectangle($replicaPaper, 46, 28, 164, 200)
$replicaFont = [System.Drawing.Font]::new('Georgia', 112, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$replicaInk = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(52, 61, 76))
$replicaFormat = [System.Drawing.StringFormat]::new()
$replicaFormat.Alignment = [System.Drawing.StringAlignment]::Center
$replicaFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
$replicaGraphics.DrawString('T', $replicaFont, $replicaInk, [System.Drawing.RectangleF]::new(46, 32, 164, 154), $replicaFormat)
$replicaPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(156, 161, 168), 4)
$replicaGraphics.DrawLine($replicaPen, 78, 186, 178, 186)
$replicaGraphics.DrawLine($replicaPen, 78, 204, 154, 204)
$replicaPng = Join-Path $PSScriptRoot '../assets/replica.png'
$replicaIco = Join-Path $PSScriptRoot '../assets/replica.ico'
$replicaBitmap.Save($replicaPng, [System.Drawing.Imaging.ImageFormat]::Png)
$replicaPngBytes = [System.IO.File]::ReadAllBytes($replicaPng)
$replicaStream = [System.IO.File]::Create($replicaIco)
$replicaWriter = [System.IO.BinaryWriter]::new($replicaStream)
$replicaWriter.Write([uint16]0); $replicaWriter.Write([uint16]1); $replicaWriter.Write([uint16]1)
$replicaWriter.Write([byte]0); $replicaWriter.Write([byte]0); $replicaWriter.Write([byte]0); $replicaWriter.Write([byte]0)
$replicaWriter.Write([uint16]1); $replicaWriter.Write([uint16]32)
$replicaWriter.Write([uint32]$replicaPngBytes.Length); $replicaWriter.Write([uint32]22); $replicaWriter.Write($replicaPngBytes)
$replicaWriter.Dispose(); $replicaStream.Dispose(); $replicaPen.Dispose(); $replicaFont.Dispose(); $replicaFormat.Dispose(); $replicaPaper.Dispose(); $replicaInk.Dispose(); $replicaGraphics.Dispose(); $replicaBitmap.Dispose()
