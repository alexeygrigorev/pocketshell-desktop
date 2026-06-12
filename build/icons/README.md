# Application Icons

Place the PocketShell application icons in this directory before packaging.

## Required Files

| File          | Platform | Size        | Notes                          |
|---------------|----------|-------------|--------------------------------|
| `icon.ico`    | Windows  | 256x256     | Multi-size ICO recommended     |
| `icon.icns`   | macOS    | 512x512     | ICNS format                    |
| `icon.png`    | Linux    | 512x512     | PNG with transparency          |

## Generating Icons

If you have a source SVG (`icon.svg`), generate platform icons with:

```bash
# Using electron-icon-builder (npm)
npx electron-icon-builder --input=icon.svg --output=.

# Or manually with ImageMagick
convert icon.svg -resize 256x256 icon.ico
convert icon.svg -resize 512x512 icon.png
# For icns, use png2icns or iconutil on macOS
```

If icons are missing, electron-builder will use a default placeholder icon.
