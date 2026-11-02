# Stage 1: build the React app with Node
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: serve the static files with nginx (no Node in the final image)
FROM nginx:1.31-alpine
# Pick up Alpine security fixes released after the base image was built
RUN apk upgrade --no-cache
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html