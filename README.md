# Zettelwerk


Leichtgewichtige Web-App zum Betrachten, Taggen, Umbenennen und Löschen (Papierkorb)
von PDFs (z. B. auf dem Netzlaufwerk). Nur Python 3 (Standardbibliothek), keine Abhängigkeiten.

## Starten

```bash
python3 server.py
```

Dann im Browser `http://<rechner-ip>:8800` öffnen – auch vom Handy im selben WLAN.
Auf dem Handy über „Zum Startbildschirm hinzufügen“ wie eine App nutzen.

## Konfiguration

Alle Einstellungen stehen in **`config.ini`** (danach Server neu starten):

```ini
[pdf-manager]
root = Docs                 ; PDF-Ordner
db = data/pdfmanager.db     ; Tag-Datenbank
host = 0.0.0.0
port = 8800
password =                  ; leer = kein Passwortschutz
scan_ttl = 120              ; automatisch neu einlesen (Sekunden)
```

Relative Pfade beziehen sich auf den Programmordner. Jede Einstellung lässt sich zusätzlich
per Umgebungsvariable überschreiben (`PDF_ROOT`, `PDF_PORT`, `PDF_PASSWORD`, …),
eine andere Konfigurationsdatei per `PDF_CONFIG=/pfad/zur/datei.ini`.

## Funktionen

- PDFs als Kacheln mit Vorschaubild; Suche, Ordner-Filter und Sortierung
- Seitenleiste links (☰ ein-/ausklappen): Ansichten **Alle**, **Neu** (seit dem ersten Start
  hinzugekommen, noch nicht geöffnet/getaggt), **Ohne Tags**, **Papierkorb** und alle Tags
  zum Filtern (mehrere Tags = UND)
- Klick auf eine Kachel öffnet das PDF als Overlay über der Seite; mit ‹ › bzw. Pfeiltasten
  zum vorherigen/nächsten PDF, Tag-Symbol für Tags & Details, Esc schließt
- „⋯“ auf der Kachel: Tags bearbeiten, Umbenennen, Papierkorb
- Tags für mehrere Dateien gleichzeitig („Auswählen“)
- Umbenennen (im selben Ordner, keine Überschreibung)
- Papierkorb: Dateien werden nach `<root>/.pdf-papierkorb/` verschoben und lassen sich
  inklusive Tags wiederherstellen. Endgültig gelöscht wird nichts.
- Viewer auf Basis von pdf.js (lädt vom CDN), funktioniert auch auf Android/iOS

## Daten

- Tags liegen in `data/pdfmanager.db` (SQLite, lokal – nicht auf dem Netzlaufwerk, wegen SMB-Locking).
  Diese Datei sichern!
- Vorschaubilder werden mit `pdftoppm` (Paket `poppler-utils`) erzeugt und in `data/thumbs/`
  zwischengespeichert. Fehlt `pdftoppm`, rendert der Browser die Vorschau und schickt sie an den Server.
- Umbenennen/Verschieben außerhalb der App: Tags werden übernommen, wenn Dateiname und Größe gleich bleiben.
- Der Ordner wird automatisch alle 2 Minuten (`scan_ttl`) bzw. per ⟳ neu eingelesen.

Autostart: siehe `pdf-manager.service`.
