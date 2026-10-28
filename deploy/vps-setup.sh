#!/usr/bin/env bash
# Sets up MOGFIELD on a fresh Ubuntu 24.04 server. Run as root:
#   curl -fsSL https://raw.githubusercontent.com/Trenchplanet/mogfield/main/deploy/vps-setup.sh | bash
# Optional: DOMAIN=api.example.com for automatic HTTPS (its DNS must point at this server first).
# Safe to run again: it updates the code and restarts the service.
set -euo pipefail

REPO="${REPO:-https://github.com/Trenchplanet/mogfield.git}"
APP_DIR=/opt/mogfield
DATA_DIR=/var/lib/mogfield
ENV_FILE=/etc/mogfield.env
DOMAIN="${DOMAIN:-}"

[ "$(id -u)" -eq 0 ] || { echo "Run this as root."; exit 1; }

echo "==> Swap (this server has little RAM)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=60 >/dev/null

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates ffmpeg ufw debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
if ! command -v caddy >/dev/null; then
  rm -f /etc/apt/sources.list.d/caddy.list /usr/share/keyrings/caddy.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

echo "==> Code"
id mogfield >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin mogfield
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull -q --ff-only; else git clone -q "$REPO" "$APP_DIR"; fi
mkdir -p "$DATA_DIR"
chown -R mogfield:mogfield "$APP_DIR" "$DATA_DIR"
# a small server needs the build kept lean
sudo -u mogfield env NODE_OPTIONS=--max-old-space-size=400 npm --prefix "$APP_DIR/app" install --no-audit --no-fund
sudo -u mogfield env NODE_OPTIONS=--max-old-space-size=400 npm --prefix "$APP_DIR/app" run build

echo "==> Settings"
if [ ! -f "$ENV_FILE" ]; then
  read -r -s -p "Paste your Comfy API key (hidden, press Enter): " KEY </dev/tty
  echo
  umask 077
  cat > "$ENV_FILE" <<EOF
COMFY_API_KEY=$KEY
BACKLOT_RENDER_CAP=3
BACKLOT_PORT=8787
BACKLOT_DATA_DIR=$DATA_DIR
BACKLOT_REPO_URL=github.com/Trenchplanet/mogfield
NODE_ENV=production
EOF
  chown root:mogfield "$ENV_FILE"; chmod 640 "$ENV_FILE"
fi

echo "==> Service"
cat > /etc/systemd/system/mogfield.service <<EOF
[Unit]
Description=MOGFIELD server
After=network-online.target
Wants=network-online.target

[Service]
User=mogfield
WorkingDirectory=$APP_DIR/app
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now mogfield >/dev/null
systemctl restart mogfield

echo "==> Web server"
SITE=":80"; [ -n "$DOMAIN" ] && SITE="$DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$SITE {
	request_body {
		max_size 250MB
	}
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
EOF
systemctl reload caddy || systemctl restart caddy

echo "==> Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

sleep 4
echo
if curl -fsS -m 10 http://127.0.0.1:8787/api/clips >/dev/null; then
  echo "MOGFIELD is running."
  echo "Try it: http://$(curl -fsS -m 5 https://api.ipify.org || echo this-server)/"
else
  echo "The server did not answer. Check:  journalctl -u mogfield -n 50 --no-pager"
fi
