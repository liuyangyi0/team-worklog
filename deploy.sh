#!/usr/bin/env bash
set -euo pipefail
# Place the built application in /srv/worklog/app before running as root.
# Adjust the sample paths, Node executable and APP_ORIGIN in *.service first.
if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this installer as root.' >&2
  exit 1
fi
cd /srv/worklog/app
if ! id worklog >/dev/null 2>&1; then
  useradd --system --home-dir /srv/worklog --shell /sbin/nologin worklog
fi
mkdir -p /srv/worklog/data
chown worklog:worklog /srv/worklog/data
chmod 700 /srv/worklog/data
for unit in worklog.service worklog-backup.service worklog-backup.timer; do
  install -m 644 "$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now worklog.service worklog-backup.timer
systemctl restart worklog.service
systemctl is-active worklog.service
printf '%s\n' 'Application installed. Configure your reverse proxy separately.'
