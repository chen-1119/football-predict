# HTTPS and TLS Operations

The light server can use a publicly trusted certificate for its fixed IPv4
address even before a DNS name is available. Let's Encrypt IP address
certificates use the `shortlived` profile and are valid for roughly six days,
so automated renewal is a hard requirement rather than an optional follow-up.

This repository never requests a certificate during a normal release. The
operator-only enable helper refuses to run unless both `ACME_AGREE_TOS=1` and a
valid `ACME_EMAIL` are supplied explicitly.

Official background:

- [Let's Encrypt IP address certificate availability](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html)
- [Certbot IP certificate instructions](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)

## Repository and Host Ownership

The repository manages these reusable pieces:

- `nginx-http-common.conf`: HTTP-context rate-limit zones, upstream, and
  version-header policy. Releases install it as
  `/etc/nginx/conf.d/football-predict-common.conf`.
- `nginx-server-common.conf`: the application locations, cache policy, SSE
  behavior, and proxy headers. Releases install it as
  `/etc/nginx/snippets/football-predict-server.conf`.
- `nginx-security-headers.conf`: response security headers included at both
  server scope and every location that defines its own cache headers, avoiding
  Nginx `add_header` inheritance loss.
- `nginx.conf`: the HTTP bootstrap site and ACME webroot.

The generated `/etc/nginx/sites-available/football-predict-tls` file is
host-local. Normal Git and bundle releases update the common includes and the
inactive HTTP bootstrap, but they do not overwrite or disable an enabled TLS
site.

## Prerequisites

1. Confirm the public address is still `134.175.132.183`.
2. Allow inbound TCP 80 and 443 in the cloud security group. Keep the project
   SSH port restricted to operator addresses.
3. Install Certbot 5.4 or newer. The `nginx` plugin does not install IP
   certificates; the helper uses `webroot` mode.
4. Confirm the vendor installation provides either `certbot.timer` or
   `snap.certbot.renew.timer`.
5. Deploy the HTTP bootstrap and verify it without credentials:

```bash
TLS_VERIFY_BASE_URL=http://134.175.132.183 \
TLS_VERIFY_MODE=bootstrap \
npm run verify:tls
```

The bootstrap check requires the app and `/api/v1/health` to return 200. Before
the new Nginx files are deployed it reports the ACME probe and version header as
advisories. After deployment, enforce both controls explicitly:

```bash
TLS_VERIFY_BASE_URL=http://134.175.132.183 \
TLS_VERIFY_MODE=bootstrap \
TLS_BOOTSTRAP_REQUIRE_ACME=1 \
TLS_BOOTSTRAP_REQUIRE_HARDENING=1 \
npm run verify:tls
```

## Staging Request

Review the CA subscriber agreement yourself, then run the staging flow. The
helper defaults to staging and deliberately does not enable the TLS site after
receiving an untrusted staging certificate.

```bash
cd /opt/football-predict
sudo -E env \
  APP_DIR=/opt/football-predict \
  TLS_IP_ADDRESS=134.175.132.183 \
  ACME_AGREE_TOS=1 \
  ACME_EMAIL=ops@example.com \
  ACME_STAGING=1 \
  bash deploy/light-server/enable-nginx-tls.sh
```

Do not use the staging certificate for public traffic.

## Production Cutover

After the staging request succeeds, make the production choice explicit:

```bash
cd /opt/football-predict
sudo -E env \
  APP_DIR=/opt/football-predict \
  TLS_IP_ADDRESS=134.175.132.183 \
  ACME_AGREE_TOS=1 \
  ACME_EMAIL=ops@example.com \
  ACME_STAGING=0 \
  bash deploy/light-server/enable-nginx-tls.sh
```

The helper requests the short-lived IP certificate, installs a Certbot deploy
hook that runs `nginx -t` before reload, atomically switches from the bootstrap
site to the host-local TLS site, and enables the discovered vendor renewal
timer. HTTP keeps serving `/.well-known/acme-challenge/`; every other HTTP path
uses a fixed `308` target of `https://134.175.132.183` rather than reflecting the
request `Host` header.

## Verification and Renewal Drill

Run strict verification from a different machine:

```bash
TLS_VERIFY_BASE_URL=https://134.175.132.183 \
TLS_VERIFY_MODE=strict \
TLS_EXPECT_IP=134.175.132.183 \
TLS_MIN_REMAINING_HOURS=36 \
npm run verify:tls
```

Strict mode validates the public trust chain and IP SAN, certificate runway,
TLS 1.2/1.3 support, TLS 1.0/1.1 rejection, the fixed HTTP redirect, ACME
bypass, application root, and v1 health. On the host, also run:

```bash
sudo nginx -t
systemctl list-timers certbot.timer snap.certbot.renew.timer --all --no-pager
sudo certbot renew --dry-run
```

The renewal deploy hook is
`/etc/letsencrypt/renewal-hooks/deploy/football-predict-nginx`. Alert when the
certificate has less than 36 hours remaining.

HSTS is not a substitute for the redirect in IP mode: RFC 6797 requires user
agents not to record an IP literal as a Known HSTS Host. Add a staged HSTS
policy only after moving to a verified DNS name.

## Rollback

If the new TLS listener fails before Nginx reload, the helper restores the HTTP
bootstrap automatically. For an operator-directed rollback after cutover:

```bash
sudo rm -f /etc/nginx/sites-enabled/football-predict-tls
sudo ln -sfn /etc/nginx/sites-available/football-predict \
  /etc/nginx/sites-enabled/football-predict
sudo nginx -t
sudo systemctl reload nginx
```

This restores availability but also restores cleartext public access. Do not
send admin or access bearer tokens until HTTPS is healthy again.

Because the service previously documented public HTTP bearer uploads, rotate
`ADMIN_TOKEN`, `ACCESS_CODE_ADMIN_TOKEN`, and
`FOOTBALL_CLOUD_ADMIN_TOKEN` after HTTPS cutover, then update collector-side
secret storage. Never put these values in URLs or logs.

## Later DNS Migration

When a domain becomes available, verify its A/AAAA records point at the intended
host before requesting a DNS certificate. Do not infer ownership from a Host
header or search result. Replace the IP template with a domain-specific
host-local site, validate renewal, then update `DATA_API_BASE` and public release
URLs to the HTTPS domain. DNS changes remain an explicit operator action.
