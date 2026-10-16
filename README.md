# Branch Changes

Eine VS-Code-Erweiterung für **den Endstand deines gesamten Git-Branches** –
wie der Dateibaum eines Pull Requests, direkt im Editor.

Wenn eine Datei in mehreren Commits geändert wurde, erscheint sie nur einmal mit
dem kombinierten Ergebnis. Vollständig zurückgenommene Änderungen zählen nicht
als Änderung. Eine Serveranbindung oder Anmeldung ist nicht nötig.

## Installation

Voraussetzungen: VS Code ab 1.85, Git im `PATH`, die aktivierte eingebaute
Git-Erweiterung und ein vertrauenswürdiger lokaler Workspace. Auf dem Zielrechner
ist keine separate Node.js- oder npm-Installation erforderlich.

1. Eine `.vsix`-Datei aus den [Releases](https://github.com/windischb/vscode-branch-changes/releases)
   herunterladen, sofern bereits eine Release verfügbar ist. Alternativ das
   Paket wie unten beschrieben selbst erstellen.
2. In VS Code **Extensions → … → Install from VSIX…** auswählen und das Paket öffnen.
3. Gegebenenfalls das VS-Code-Fenster neu laden.

Alternativ per Terminal:

```sh
code --install-extension branch-changes-0.1.0.vsix
```

Updates aus GitHub-Releases werden auf demselben Weg manuell installiert.

## Bedienung

1. Ein Git-Repository öffnen und links in der Activity Bar **Branch Changes** auswählen.
2. Über **Select Target Branch** den Vergleichsbranch wählen, zum Beispiel `origin/main`.
3. Eine geänderte Datei anklicken, um den nativen, schreibgeschützten Diff zu öffnen.

- **Vollständiger Baum:** Committete Dateien und Ordner bleiben als Kontext sichtbar;
  unveränderte Pfade sind blass. Dateityp-Icons stammen aus dem aktiven Theme,
  farbige Status-Badges kennzeichnen Änderungen.
- **Show Changes Only / Show All Files:** Zwischen Nettoänderungen und vollständigem
  Kontext umschalten.
- **Show Ignored Files / Hide Ignored Files:** Im vollständigen Baum zusätzlich
  ignorierte lokale Dateien ein-/ausblenden. Ohne diese Option gelten die
  Git-Ignore-Regeln einschließlich globaler Excludes.
- **Lokaler Kontext:** Nicht committete Zusatzdateien sind ausdrücklich mit `local`
  bzw. `ignored · local` gekennzeichnet. Sie öffnen die lokale Datei und fließen
  niemals in den Branch-Diff oder Änderungszähler ein.
- **Refresh:** Die Ansicht aktualisiert sich bei Git-Änderungen automatisch.
  Für ignorierte lokale Dateien gegebenenfalls manuell aktualisieren.
- **Select Repository:** Bei mehreren geöffneten Repositories den Vergleich wechseln.

Ansichtsoptionen und eigene Auf-/Zuklappentscheidungen werden gespeichert.
Neue Ordner sind zunächst offen, wenn sie committete Änderungen enthalten,
andernfalls geschlossen. Eigene Entscheidungen haben Vorrang.
Ein Refresh schließt oder ersetzt keine Editor-Tabs. Historische Inhalte bleiben
an ihren ursprünglichen Commit gebunden; ein erneuter Klick öffnet den neuen Stand.
Für einzelne Klicks gilt weiterhin VS Codes normales Vorschau-Tab-Verhalten.

## Vergleich und Grenzen

Der Vergleich entspricht `git diff <zielbranch>...HEAD`: gemeinsamer Vorfahr
von Zielbranch und aktuellem Branch gegen den aktuellen Commit.

- **Nur committete Änderungen:** Staging Area und Arbeitskopie beeinflussen den
  Diff nicht. Committete Einträge haben Vorrang vor lokalem Dateikontext.
- Umbenennungen werden von Git erkannt. Neue, gelöschte und umbenannte Dateien
  erscheinen zusammen mit allen anderen Nettoänderungen im selben Baum.
- Getrackte Dateien bleiben trotz Ignore-Regeln sichtbar. Git-Metadaten und lokale
  Inhalte eingebetteter Repositories/Submodule werden nicht durchlaufen.
- Symlinks zeigen den gespeicherten Linkpfad, Submodule ihre Commit-ID.
  Reine Dateimodus-Änderungen werden beim Öffnen erläutert.
- Binärdateien werden aufgelistet, aber nicht als Text-Diff geöffnet.
  Textinhalte werden als UTF-8 gelesen.
- Die Erweiterung führt kein Fetch, Checkout oder Merge aus und schreibt nicht
  in dein Repository. Remote-Tracking-Branches bei Bedarf selbst aktualisieren.
- Fehlende oder uneindeutige Historie wird als Fehler gemeldet. Bei einem
  Refresh-Fehler bleibt die letzte erfolgreiche Ansicht erhalten.
- Git-Aufrufe sind auf 15 Sekunden und 32 MiB Ausgabe begrenzt. Sehr große
  ignorierte Verzeichnisse können diese Grenze erreichen; dann bleibt der
  committete Baum ohne zusätzlichen lokalen Kontext verfügbar.
- Bisher praktisch unter macOS geprüft; Windows und Linux sind noch nicht verifiziert.

## Entwicklung

Node.js ab 18 und Git genügen für die Tests; es gibt keine Projektabhängigkeiten:

```sh
npm run check
npm test
```

Zum Ausprobieren den Projektordner in VS Code öffnen und **Run → Run Without
Debugging** mit der Konfiguration **Run Branch Changes** starten. Im neuen
Extension-Development-Host das gewünschte Git-Repository öffnen.

Mit `code` im `PATH` führt `npm run test:vscode` zusätzlich einen Hosttest mit
nativen Diffs aus. Er öffnet ein temporäres Test-Repository mit separatem Profil;
vorhandene VS-Code-Einstellungen bleiben unverändert. Nur in diesem isolierten
Testprozess wird die Workspace-Trust-Abfrage für das selbst erzeugte Fixture deaktiviert.

### VSIX erstellen

Mit einer vom aktuellen `vsce` unterstützten Node.js-Version im Projektordner:

```sh
npx @vscode/vsce package --no-dependencies
```

`npx` lädt bei Bedarf das Packaging-Werkzeug herunter. Der Befehl veröffentlicht
nichts und erzeugt `branch-changes-0.1.0.vsix`. Das Paket enthält nur die
Runtime-Dateien, das Activity-Bar-Icon, die Paketbeschreibung und diese README.
Für eine neue Release zuerst die Versionsnummer in `package.json` erhöhen und
die erzeugte VSIX als Release-Asset anhängen.
