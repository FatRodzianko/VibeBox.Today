# Vibebox.today

A web app for creating rooms where friends can queue and watch YouTube videos together.

## Requirements

- Docker Engine and the Docker Compose plugin, or Docker Desktop with Compose
- A modern web browser
- Internet access to YouTube

## Run locally with Node.js

Install dependencies and create the lockfile:

```sh
npm install
```

Start the app:

```sh
npm start
```

Open http://localhost:3000.

To use a different local port:

```sh
PORT=3001 npm start
```

The room data is saved in `rooms.json` when running directly with Node.js.

## Run with Docker Compose

Copy the sample environment file:

```sh
cp .env.example .env
```

Edit `.env` if you want a different public host port, then build and start:

```sh
docker compose up --build -d
```

Open `http://SERVER_ADDRESS:HOST_PORT`, using the `HOST_PORT` value from `.env`.

To view logs:

```sh
docker compose logs -f
```

To stop the app without deleting its saved room data:

```sh
docker compose down
```

Room data is stored in the `vibebox-data` Docker volume. To remove the app **and permanently delete that data**, run:

```sh
docker compose down --volumes
```

## GitHub

Generate and commit `package-lock.json`:

```sh
npm install
```

Do not commit `.env`, `rooms.json`, or real credentials. The project `.gitignore` excludes them.

## Deployment notes

The published port must be allowed through the server’s firewall and any router or hosting-provider firewall. For a public deployment, use HTTPS—typically by putting the app behind a reverse proxy that handles TLS. The Docker configuration limits the container’s privileges, but containers should not be treated as a complete security boundary from their host.
