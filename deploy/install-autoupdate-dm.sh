#!/bin/sh
# DM dashboard: /opt/dm-src is the git clone, /opt/dm-dashboard is what the service runs.
# Every 3 minutes: pull in dm-src; if new, back up the live folder to dm-dashboard.prev,
# copy the new code over it (nothing is deleted, so data/uploads/node_modules stay), and restart.
set -e
SRC=/opt/dm-src; LIVE=/opt/dm-dashboard; SVC=dm-dashboard
[ -d "$SRC/.git" ] || { echo "$SRC is not a git clone"; exit 1; }

cat > /usr/local/bin/$SVC-update.sh <<S
#!/bin/sh
export HOME=/root
cd $SRC || exit 1
OLD=\$(git rev-parse HEAD)
git pull --ff-only -q || exit 1
NEW=\$(git rev-parse HEAD)
[ "\$OLD" = "\$NEW" ] && exit 0
rm -rf $LIVE.prev && mkdir $LIVE.prev
tar -C $LIVE --exclude=node_modules -cf - . | tar -C $LIVE.prev -xf -
tar -C $SRC --exclude=.git -cf - . | tar -C $LIVE -xf -
git diff --name-only \$OLD \$NEW | grep -q "^package.*json\$" && (cd $LIVE && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1)
systemctl restart $SVC
exit 0
S
chmod +x /usr/local/bin/$SVC-update.sh

cat > /etc/systemd/system/$SVC-update.service <<S
[Unit]
Description=Pull and deploy $SVC when GitHub has changes
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
