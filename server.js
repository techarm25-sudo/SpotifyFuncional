const express = require("express");
const yts = require("yt-search");
const { execSync } = require("child_process");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");

// Configuración de Spotify con manejo de errores
let getTracks;
try {
    const fetch = require('node-fetch');
    getTracks = require('spotify-url-info')(fetch).getTracks;
} catch (e) {
    console.log("⚠️ Error cargando librerías de Spotify. Ejecuta: npm install spotify-url-info node-fetch@2");
}

const app = express();
app.use(cors());

// Timeout para descargas largas (5 minutos)
app.use((req, res, next) => {
    res.setTimeout(300000);
    next();
});

// Servir archivos estáticos (HTML, CSS, JS)
const publicPath = path.resolve(__dirname);
console.log('Archivos en publicPath:', fs.readdirSync(publicPath));

// Carpeta temporal para descargas
const DOWNLOADS_DIR = path.join(publicPath, 'temp_downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);

// Ruta principal: sirve index.html si existe, de lo contrario prueba.html
app.get('/', (req, res) => {
    const indexFile = path.join(publicPath, 'index.html');
    if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
    } else {
        res.sendFile(path.join(publicPath, 'prueba.html'));
    }
});

// Ruta de progreso (EventSource)
app.get("/playlist-progress", async (req, res) => {
    const url = req.query.url;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendProgress = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
        let cancionesParaBuscar = [];
        let esSpotify = url.includes('spotify.com');

        if (esSpotify) {
            if (!getTracks) throw new Error("Librería Spotify no instalada en el servidor.");
            sendProgress({ status: "Analizando lista de Spotify..." });
            const tracks = await getTracks(url);
            cancionesParaBuscar = tracks.map(t => {
                const nombreCancion = t.name || "Canción desconocida";
                const nombreArtista = (t.artists && t.artists.length > 0) ? t.artists[0].name : "";
                return `${nombreCancion} ${nombreArtista}`.trim();
            });
        } else {
            sendProgress({ status: "Analizando lista de YouTube..." });
            const rawIds = execSync(`yt-dlp --get-id --flat-playlist "${url}"`).toString();
            cancionesParaBuscar = rawIds.trim().split('\n').map(id => `https://www.youtube.com/watch?v=${id.trim()}`);
        }

        const total = cancionesParaBuscar.length;
        if (total === 0) throw new Error("No se encontraron canciones en el enlace.");

        const folderName = `lista-${Date.now()}`;
        const folderPath = path.join(DOWNLOADS_DIR, folderName);
        fs.mkdirSync(folderPath);

        for (let i = 0; i < total; i++) {
            sendProgress({
                status: `Descargando ${i + 1} de ${total}: ${cancionesParaBuscar[i].substring(0, 30)}...`,
                current: i + 1,
                total: total
            });

            let query = cancionesParaBuscar[i];
            let comando = esSpotify
                ? `yt-dlp -x --audio-format mp3 --no-playlist -o "${folderPath}/%(title)s.%(ext)s" "ytsearch1:${query}"`
                : `yt-dlp -x --audio-format mp3 --no-playlist -o "${folderPath}/%(title)s.%(ext)s" "${query}"`;

            try {
                execSync(comando);
            } catch (e) {
                console.error(`Error descargando: ${query}`);
            }
        }

        sendProgress({ status: "Comprimiendo archivos en un ZIP..." });
        const zipName = `${folderName}.zip`;
        const zipPath = path.join(DOWNLOADS_DIR, zipName);
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            sendProgress({ status: "Completado", file: zipName });
            res.end();
        });

        archive.pipe(output);
        archive.directory(folderPath, false);
        await archive.finalize();

        // Eliminar carpeta temporal
        fs.rmSync(folderPath, { recursive: true, force: true });

    } catch (error) {
        console.error("ERROR DEL SISTEMA:", error.message);
        sendProgress({ status: "Error: " + error.message });
        res.end();
    }
});

// Ruta para descargar el ZIP
app.get("/get-zip", (req, res) => {
    const fileName = req.query.file;
    const filePath = path.join(DOWNLOADS_DIR, fileName);
    res.download(filePath, (err) => {
        if (!err && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    });
});

// Ruta de búsqueda (opcional)
app.get("/search", async (req, res) => {
    try {
        const result = await yts(req.query.q || "");
        res.json(result.videos.slice(0, 5).map(v => ({ title: v.title, url: v.url, thumbnail: v.thumbnail })));
    } catch (e) {
        res.status(500).json({ error: "Fallo en la búsqueda" });
    }
});

// PUERTO DINÁMICO (clave para Railway)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("============================================");
    console.log("✅ SERVIDOR MULTIMEDIA INICIADO");
    console.log(`📂 Carpeta: ${publicPath}`);
    console.log(`🌐 URL Local: http://localhost:${PORT}/`);
    console.log("============================================");
});