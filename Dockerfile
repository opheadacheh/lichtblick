# Build stage
FROM node:22 AS build
WORKDIR /src
COPY . ./
COPY --from=turbodata ts /turbodata/ts

RUN corepack enable
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 yarn install --immutable

RUN yarn run web:build:prod

# Release stage
FROM caddy:2.5.2-alpine
WORKDIR /src
COPY --from=build /src/web/.webpack ./viz/

EXPOSE 8080

COPY <<EOF /entrypoint.sh
# Optionally override the default layout with one provided via bind mount
mkdir -p /lichtblick
touch /lichtblick/default-layout.json
index_html=\$(cat viz/index.html)
replace_pattern='/*LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER*/'
replace_value=\$(cat /lichtblick/default-layout.json)
echo "\${index_html/"\$replace_pattern"/\$replace_value}" > viz/index.html

# Continue executing the CMD
exec "\$@"
EOF

ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
CMD ["caddy", "file-server", "--listen", ":8080"]
