# App icon assets

The user supplied the restaurant POS artwork used for the app icon. Preparation used the built-in image-generation tool in edit mode, using that supplied image as the reference. The final preparation instructions were: preserve the supplied POS artwork and composition, remove the exterior background to transparency, and add no text or objects. The prepared image is derived from the reference; it is not a pixel-identical copy of the original attachment.

`public/icons/app-icon-source.png` is the prepared source. The remaining icon assets are generated from it with deterministic resizing and layout, without further image generation:

| Asset | Purpose |
| --- | --- |
| `public/icons/app-icon-192.png` | 192-pixel PWA icon |
| `public/icons/app-icon-512.png` | 512-pixel PWA icon |
| `public/icons/maskable-512.png` | Maskable PWA icon with padding for platform crops |
| `public/icons/apple-touch-icon.png` | Apple touch/home-screen icon |
| `public/icons/favicon-32.png` | Browser favicon |

This records the source and preparation method. It does not assert verified copyright ownership or an external license for the user-supplied artwork.
