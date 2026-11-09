# Akari

Plataforma de streaming de animación para Windows, con la estructura de Crunchyroll: portada con
destacados, Explorar por género, Mi lista, Historial, «Continuar viendo», página de serie con
episodios y un reproductor propio. Además, **todo lo que ves queda guardado** y puedes verlo sin
conexión y respaldarlo en la carpeta que elijas.

Ejecutable: **`dist\Akari.exe`** (portátil, no necesita instalación).

## Catálogo

Akari no se conecta a Crunchyroll: su catálogo está protegido con DRM y su licencia no permite
guardarlo. Trae películas de animación con licencia abierta de la Blender Foundation
(*Sintel*, *Tears of Steel*, *Elephants Dream*, *Big Buck Bunny*, con licencia CC BY) y puedes
sumar lo tuyo desde **Ajustes → Agregar a la biblioteca**:

- **Importar una carpeta**: cada subcarpeta es una serie (`Temporada 1`, `Season 2`… se agrupan).
  Los subtítulos `.srt`/`.vtt` con el mismo nombre del video se cargan solos
  (`Serie - 01.es.srt`, también en una subcarpeta `subs`).
- **Enlace directo** a un MP4 o WebM que tengas derecho a guardar.

El buscador busca a la vez en tu catálogo y en Crunchyroll, Pluto TV, el canal de YouTube
«Crunchyroll en Español», JustWatch, YouTube y Facebook, y muestra todos los resultados juntos,
agrupados por sitio, en la misma pantalla. Cada sitio aparece en cuanto responde, en unos
segundos. Al tocar un resultado se abre **dentro de la ventana de Akari** y el video se reproduce
ahí mismo; «Ver en…» abre la búsqueda completa de ese sitio, también dentro de Akari.

Si un sitio pide verificar que eres humano (Crunchyroll) o iniciar sesión (Facebook), Akari lo
avisa en su fila: ábrelo, hazlo una vez y vuelve a buscar; queda guardado. Akari no ve tus
contraseñas. Lo que veas en estos sitios no se guarda para verlo sin conexión. La entrada
**Crunchyroll** del menú abre su portada.

Formatos: MP4/MOV/M4V (H.264) y WebM. AVI y HEVC no se pueden reproducir; en MKV solo
funcionan los que usan códecs compatibles y no se leen sus subtítulos incluidos.

## Sin conexión: la caché persistente

- El video se guarda **a medida que llega**, en bloques de 1 MB. Volver a verlo, o retroceder,
  no usa la red. Si saltas a una parte nueva, se pide desde ahí al instante.
- Con **Guardar completo lo que reproduzco** (activado de serie), al empezar un video el resto se
  descarga en segundo plano. También hay botones **Descargar** y **Descargar todo**.
- **Nunca se borra nada automáticamente.** Los datos están en
  `%APPDATA%\Akari\cache` (no en la carpeta temporal de Windows, que el sistema sí limpia).
  Solo desaparecen si pulsas **Borrar** en Descargas, que pide confirmación. La única excepción:
  si el archivo cambia en su origen, se descarta la parte guardada de la versión anterior para no
  mezclar dos versiones.
- Descargas a medio terminar siguen donde quedaron al reabrir la app o al volver la conexión.
- Puedes **mover la caché** a otro disco en Ajustes → Caché de videos.
- **Modo sin conexión** obliga a no usar la red. Sin conexión, lo que no está guardado aparece
  en gris; un video guardado a medias se puede ver hasta donde llegue.

## Respaldos en tu carpeta

En **Descargas** o **Ajustes → Respaldos**:

1. **Elegir carpeta**: cualquier carpeta, también un disco externo.
2. **Respaldar todo**: copia los videos completos como archivos normales, por serie
   (`Sintel\01 - Sintel (película completa).mp4`), con sus subtítulos `.vtt` al lado.
   Es incremental: lo que ya está no se vuelve a copiar.
3. **Respaldar automáticamente**: copia cada video en cuanto termina de guardarse.

La carpeta incluye `akari-respaldo.json` con la huella SHA-256 de cada video, tu lista, tu
progreso y tu biblioteca. Akari solo escribe sus propios archivos ahí y nunca borra nada.

- Si borras un video de la caché, se sigue reproduciendo **desde el respaldo**.
- **Restaurar** lo copia de vuelta a la caché y verifica la huella; un archivo dañado se rechaza.
- **Recuperar un respaldo** conecta una carpeta creada antes, incluso en otro equipo.

## Teclas del reproductor

| Tecla | Acción |
|---|---|
| Espacio / K | Pausa / seguir |
| ← / → | −5 s / +5 s |
| ↑ / ↓ | Volumen |
| F, doble clic | Pantalla completa |
| M | Silenciar |
| N | Siguiente video |
| Esc | Volver a la serie |

**+85 s** salta el opening. En el menú ☰ eliges subtítulos y velocidad. La barra muestra en gris
claro qué partes del video ya están guardadas.

## Desarrollo

```
npm install
npm start          # abre la app
npm test           # pruebas del motor de caché y de respaldos
npm run e2e        # prueba completa con la app real y videos de internet
npm run dist       # genera dist\Akari.exe
```

`npm run e2e -- --art` vuelve a generar las imágenes del catálogo (`src/renderer/art`) a partir
de fotogramas de las propias películas.
