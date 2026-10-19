#!/bin/sh
# Usage: sh install-autoupdate.sh [service-name] [folder]   (defaults: dinner-planner, /opt/<service-name>)
# Installs a systemd timer that pulls GitHub every 3 minutes and restarts the app when something changed.
set -e
SVC="${1:-dinner-planner}"
DIR="${2:-/opt/$SVC}"
[ -d "$DIR/.git" ] || { echo "$DIR is not a git clone"; exit 1; }

cat > /usr/local/bin/$SVC-update.sh <<S
#!/bin/sh
cd "$DIR" || exit 1
OLD=\$(git rev-parse HEAD)
git pull --ff-only -q || exit 1
NEW=\$(git rev-parse HEAD)
[ "\$OLD" = "\$NEW" ] && exit 0
git diff --name-only \$OLD \$NEW | grep -q "^package.*json\$" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1
systemctl restart $SVC
exit 0
S
chmod +x /usr/local/bin/$SVC-update.sh

cat > /etc/systemd/system/$SVC-update.service <<S
[Unit]
Description=Pull and restart $SVC when GitHub has changes
[Service]
Type=oneshot
ExecStart=/usr/local/bin/$SVC-update.sh
S

cat > /etc/systemd/system/$SVC-update.timer <<S
[Unit]
Description=Check GitHub for $SVC updates
[Timer]
OnBootSec=2min
OnUnitActiveSec=3min
[Install]
WantedBy=timers.target
S

systemctl daemon-reload
systemctl enable --now $SVC-update.timer
/usr/local/bin/$SVC-update.sh && echo "update check works"
systemctl list-timers $SVC-update.timer --no-pager
