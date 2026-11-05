# Sourced by the tools that start servers with NODE_ENV=production, which
# refuses the development fallbacks: keeps the caller's secrets, else random.
for name in HYPER_SNAPSHOT_SECRET APP_SECRET DISPATCH_SECRET ADMIN_SECRET; do
  if [ -z "${!name}" ]; then export "$name=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"; fi
done
