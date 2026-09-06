# Photo Metadata Explorer

A static, browser-only page for inspecting metadata carried inside image files.

It currently displays:

- browser-visible file properties and a SHA-256 digest;
- EXIF, XMP, IPTC, ICC, JFIF, Photoshop resources, maker notes, PNG text, and other format-specific metadata exposed by ExifReader;
- parsed and validated C2PA Content Credentials, when present;
- a top-level JPEG, PNG, WebP, or ISO-BMFF container inventory;
- a complete JSON report that can be copied or downloaded for comparison across devices.

Images are processed locally. This app does not upload selected files to a backend. Browser security boundaries mean it cannot read operating-system extended attributes such as macOS `kMDItemWhereFroms`.

The page deliberately does not classify an image as AI-generated. This phase is intended to observe which metadata survives different download, save, upload, and device paths.

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
npm ci
npm run build
```

The generated static site is written to `dist/`.

## GitHub Pages

The included workflow builds and deploys every push to `main`. In the repository settings, open **Pages**, set **Source** to **GitHub Actions**, and run the **Deploy to GitHub Pages** workflow if it has not started automatically.

## Interpretation boundary

“No C2PA manifest found” or an empty metadata result means only that the supported metadata was not found in that particular file copy. It is not evidence that the image is authentic or human-created.
