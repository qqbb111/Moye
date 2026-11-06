Add-Type -AssemblyName System.Drawing
$iconImages = @()
foreach ($iconSize in @(16,24,32,48,64,128,256)) {
  $bitmap = [System.Drawing.Bitmap]::new($iconSize,$iconSize)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.ScaleTransform($iconSize/48.0,$iconSize/48.0)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $jade = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#b3d0c3'))
  $ink = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#203a34'))
  $fold = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#719e8a'))
  $round = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $round.AddArc(2,2,24,24,180,90); $round.AddArc(22,2,24,24,270,90); $round.AddArc(22,22,24,24,0,90); $round.AddArc(2,22,24,24,90,90); $round.CloseFigure()
  $graphics.FillPath($jade,$round)
  $paperPoints = [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(14,11),[System.Drawing.PointF]::new(29,11),[System.Drawing.PointF]::new(36,18),[System.Drawing.PointF]::new(36,38),[System.Drawing.PointF]::new(14,38))
  $graphics.FillPolygon($ink,$paperPoints)
  $graphics.FillPolygon($fold,[System.Drawing.PointF[]]@([System.Drawing.PointF]::new(29,11),[System.Drawing.PointF]::new(29,18),[System.Drawing.PointF]::new(36,18)))
  $pen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#eff5ee'),2.5)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round; $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round; $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $graphics.DrawLines($pen,[System.Drawing.PointF[]]@([System.Drawing.PointF]::new(18,31),[System.Drawing.PointF]::new(18,21),[System.Drawing.PointF]::new(25,28),[System.Drawing.PointF]::new(32,21),[System.Drawing.PointF]::new(32,31)))
  $pngStream = [System.IO.MemoryStream]::new(); $bitmap.Save($pngStream,[System.Drawing.Imaging.ImageFormat]::Png)
  $iconImages += [pscustomobject]@{Size=$iconSize;Bytes=$pngStream.ToArray()}
  if ($iconSize -eq 256) { $bitmap.Save((Join-Path $PSScriptRoot '../assets/replica.png'),[System.Drawing.Imaging.ImageFormat]::Png) }
  $pngStream.Dispose();$pen.Dispose();$round.Dispose();$jade.Dispose();$ink.Dispose();$fold.Dispose();$graphics.Dispose();$bitmap.Dispose()
}
$stream = [System.IO.File]::Create((Join-Path $PSScriptRoot '../assets/replica.ico')); $writer = [System.IO.BinaryWriter]::new($stream)
$writer.Write([uint16]0);$writer.Write([uint16]1);$writer.Write([uint16]$iconImages.Count)
$offset = 6+16*$iconImages.Count
foreach ($iconImage in $iconImages) {
  $dimension=if($iconImage.Size-eq256){0}else{$iconImage.Size}
  $writer.Write([byte]$dimension);$writer.Write([byte]$dimension);$writer.Write([uint16]0);$writer.Write([uint16]1);$writer.Write([uint16]32);$writer.Write([uint32]$iconImage.Bytes.Length);$writer.Write([uint32]$offset);$offset+=$iconImage.Bytes.Length
}
foreach($iconImage in $iconImages){$writer.Write([byte[]]$iconImage.Bytes)}
$writer.Dispose();$stream.Dispose()
