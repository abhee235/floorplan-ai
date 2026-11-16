# Render each tools/fixtures/plans-pictures/<name>/draw.json to picture.png (System.Drawing, Windows).
# Only needed when the pictures are rebuilt; the PNGs are committed.
Add-Type -AssemblyName System.Drawing
$root = Join-Path $PSScriptRoot '..\..\fixtures\plans-pictures'
foreach ($dir in Get-ChildItem -Directory $root) {
  $spec = Get-Content (Join-Path $dir.FullName 'draw.json') -Raw | ConvertFrom-Json
  $bmp = New-Object System.Drawing.Bitmap ([int]$spec.size[0]), ([int]$spec.size[1])
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.Clear([System.Drawing.Color]::White)
  function P($p) { New-Object System.Drawing.PointF ([float]$p[0]), ([float]$p[1]) }
  foreach ($o in $spec.ops) {
    switch ($o.op) {
      'line' {
        $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml($o.c)), ([float]$o.w)
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $g.DrawLines($pen, [System.Drawing.PointF[]]@($o.pts | ForEach-Object { P $_ }))
        $pen.Dispose()
      }
      'poly' {
        $pts = [System.Drawing.PointF[]]@($o.pts | ForEach-Object { P $_ })
        if ($o.fill) { $b = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($o.fill)); $g.FillPolygon($b, $pts); $b.Dispose() }
        if ($o.stroke) { $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml($o.stroke)), ([float]$o.w); $g.DrawPolygon($pen, $pts); $pen.Dispose() }
      }
      'circle' {
        $r = [float]$o.r
        $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml($o.stroke)), ([float]$o.w)
        $g.DrawEllipse($pen, [float]$o.c[0] - $r, [float]$o.c[1] - $r, 2 * $r, 2 * $r)
        $pen.Dispose()
      }
      'text' {
        $font = New-Object System.Drawing.Font $o.font, ([float]$o.size)
        $sz = $g.MeasureString($o.text, $font)
        $g.DrawString($o.text, $font, [System.Drawing.Brushes]::Black, [float]$o.at[0] - $sz.Width / 2, [float]$o.at[1] - $sz.Height / 2)
        $font.Dispose()
      }
    }
  }
  $g.Dispose()
  $bmp.Save((Join-Path $dir.FullName 'picture.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  "rendered $($dir.Name)"
}
