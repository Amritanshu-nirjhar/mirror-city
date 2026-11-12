# The official postgis/postgis image is amd64-only; this builds PostGIS on the official
# multi-arch postgres image so it also runs natively on Apple Silicon.
FROM postgres:17
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
 && rm -rf /var/lib/apt/lists/*
COPY init.sql sims.sql /docker-entrypoint-initdb.d/
