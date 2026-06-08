# YMus Windows Release

This folder contains the signed Chromium CRX release used by YMus Desktop.

Expected public URLs:

- `https://updates.ymus.tech/ymus/chromium/update.xml`
- `https://updates.ymus.tech/ymus/chromium/YMus-1.1.2.crx`

Upload to the server:

```bash
sudo mkdir -p /var/www/ymus-updates/ymus/chromium
sudo cp update.xml /var/www/ymus-updates/ymus/chromium/update.xml
sudo cp YMus-1.1.2.crx /var/www/ymus-updates/ymus/chromium/YMus-1.1.2.crx
sudo caddy reload --config /etc/caddy/Caddyfile
```

Verify after upload:

```bash
curl -I https://updates.ymus.tech/ymus/chromium/update.xml
curl -I https://updates.ymus.tech/ymus/chromium/YMus-1.1.2.crx
sha256sum /var/www/ymus-updates/ymus/chromium/YMus-1.1.2.crx
```

The CRX SHA-256 must be:

```text
9e9c57dc845ae703bd87f70ae7db679e664600c5d90ac85c722a87e0c7856757
```

Note: YMus Desktop writes Chromium `ExtensionInstallForcelist` policy values. Some browsers may only accept self-hosted force-installed CRX packages in managed or enterprise-like environments.
