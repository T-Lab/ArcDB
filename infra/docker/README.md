# ArcDB container images

The service Dockerfiles build from the repository root because ArcDB workspace
packages are compiled together. Images run as the unprivileged `node` user.

The migration image is intentionally separate from API startup. Compose waits
for it to migrate and seed successfully before starting request-serving or
worker processes. Production deployments should run the same image as a
one-shot release job, with `NODE_ENV=production` and the seed command omitted.
