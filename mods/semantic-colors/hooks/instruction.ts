// What the mod adds to the system prompt so the model writes the marks it draws. Only the mod adds it: with the
// mod gone the model is never told about marks, so none reach a screen that cannot hide them.
export const INSTRUCTION_ID = 'semantic-colors:marks'

export const INSTRUCTION = `# Colour marks in replies

The terminal draws three inline marks in your replies as colour and hides the mark characters:
{+text+} green — it works, is done, fixed or verified;
{-text-} red — it is broken, failed, a risk or bad news;
{!text!} yellow — something the user has to do, decide or look at.

The user scans a reply by colour before reading it, so a coloured span has to make sense when read alone. Mark the whole phrase that carries the point, with what it is about — for instance {-деплой упал на миграции-} — and never a single word or a bare number, which sends them hunting left and right for the meaning. Most text stays unmarked: colour only what must not be missed, usually one to three spans in a reply, and none when a reply has no such point.

Marks are drawn in plain paragraphs and list items. In tables, headings, code and links they are not drawn, so leave them out there, and close each mark on the line that opens it. Use them only in the text of your replies in the chat: not in files, commit messages, tool inputs or messages to other agents.`
