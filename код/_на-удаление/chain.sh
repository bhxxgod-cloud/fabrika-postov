#!/bin/zsh
cd ~/Desktop/neironka-poster
export DB_PUBLIC_URL=$(cat /tmp/dburl.txt)
export SHOT_DIR=/tmp
until grep -q "РЕАЛЬНАЯ ёмкость" /tmp/audit.log 2>/dev/null; do sleep 30; done
echo "=== АУДИТ ЗАВЕРШЁН, стартую релогин ===" 
node relogin.cjs 26 2>&1
