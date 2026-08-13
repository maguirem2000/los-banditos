#!/bin/sh
# Sync shared engine files into the munchers site (run after editing app.js/sw.js/style.css)
cd "$(dirname "$0")"
cp assets/app.js munchers/assets/app.js
cp sw.js munchers/sw.js
head -n -0 assets/style.css > munchers/assets/style.css
cat >> munchers/assets/style.css << 'CSS'

/* — Munchers brand: teal accent overriding the Banditos gold — */
:root {
  --gold: #0d9488;
  --gold-bright: #2dd4bf;
}
CSS
echo "synced engine -> munchers/"
