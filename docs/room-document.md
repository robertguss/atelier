# The room document

Every room has a document: a shared, current record of the work that the
people in the room and its agents keep together. It holds what has happened,
findings, ideas, changes of direction and open questions. Robert and a
teammate edit it in the web app. The agents read it at the start of their
turns and add to it on their own.

The document is made of blocks. A block is one heading, paragraph, list item,
to-do, numbered item, quote, code block or divider. A heading and the blocks
under it form a section.

Rooms made before the document existed get one from the default template the
first time someone opens them.

## The room layout

On a laptop or any wide window, the room opens on the document. The agent pane
sits to its left and team chat to its right. The first time you open a room,
the agent pane is open and team chat is folded. After that, each panel opens
the way you last left it in that room, in that browser.

- **Hide agents** and **Hide team chat** fold a panel into a narrow strip at the
  edge of the window. Select the strip (**Show agents** or **Show team chat**)
  to open it again.
- A folded agent pane shows a badge: "1 question" (or "2 questions", and so on)
  when a question card is waiting, otherwise "Working" while an agent runs.
- A folded team chat shows how many messages from others arrived since you
  last had it open, for example "3 unread".
- Drag the line between a panel and the document to resize it, or focus the
  line and use the arrow keys. A panel takes at most 40% of the width.

On a narrow window the document fills the room, and **Agents** and **Team
chat** in the header open the panels as sheets. They show the same badges.

The document header reads "Shared with everyone in the room, agents included."
It holds **Call in the scribe**, **History** and, for Robert only, **Save as
template**.

## Writing in the document

People can edit any block, whoever wrote it. There is no Edit button: click a
block and type. Your text saves itself a second after you stop typing, when you
click away and when you switch tabs. Each block shows its author underneath.
Editing someone else's block does not change its author. Click the space below
the last block to add an empty paragraph there.

Bold, italic, strikethrough, inline code and links show as formatted text and
are kept as markdown in the block. Undo (Ctrl+Z or Cmd+Z) works within one
block; it cannot undo a split or merge.

### Keys

| Key                                              | What it does                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Enter                                            | Splits the block at the caret into two of the same kind. At the end of a heading or paragraph, the new block is a paragraph. |
| Enter at the start                               | Adds an empty block of the same kind above.                                                                                  |
| Enter in an empty item                           | Turns an empty list item, to-do, numbered item or quote into a paragraph.                                                    |
| Shift+Enter                                      | Adds a line break inside the block.                                                                                          |
| Backspace at the start                           | Turns a list item, to-do, numbered item, quote or code block into a paragraph with the same text.                            |
| Backspace at the start of a paragraph or heading | Joins it to the end of the block above. A heading at the top becomes a paragraph.                                            |
| Arrow Up and Down                                | On a block's first or last line, move to the block above or below.                                                           |
| In a code block                                  | Enter adds a new line; Ctrl+Enter or Cmd+Enter adds a paragraph below.                                                       |

Backspace at the start of a block right after a divider removes the divider. A
join is refused, with a note naming them, when someone else is editing the
block above ("_name_ is editing the block above"), and when the joined text
would pass 4,000 characters.

### Kinds of block

Type a marker at the start of a block to change its kind: `# ` for a heading,
`- ` for a list item, `1. ` for a numbered item, `[] ` for a to-do, `> ` for a
quote and three backticks for a code block. Or type `/` and pick a kind from
the menu, filtering by name as you type. The block keeps its text, author and
comments. Undo right after the change turns it back.

- **To-do**: select its checkbox to tick or untick it. Ticking takes no lock
  and is one entry in history, but it is refused while someone else is
  editing the block. Changing a ticked to-do into another kind drops the tick.
- **Numbered item**: shows its place in the run of numbered items next to it.
  The number is never stored, so moving blocks renumbers them.
- **Code block**: text is kept exactly as typed, with no formatting.
- **Divider**: a line between blocks. `---` or **Divider** in the menu turns
  an empty block into a divider. On a block with text, the divider goes below
  it and the block stays as it is. Select a divider and press Enter to add a
  paragraph below it, or Backspace or Delete to remove it.

### Moving, pasting and deleting

Each block has a handle, **Reorder block**, at its left. Drag it to move the
block; a line marks where it will land. Or focus the handle and press
Alt+Shift+Up or Alt+Shift+Down to move the block one place. A screen reader
hears "Moved to position 3 of 8", and focus stays on the handle.

Pasting text that makes more than one block, such as paragraphs separated by
blank lines, adds them as blocks after the block you paste into. That block
keeps the text before the caret, and the last pasted block ends with the text
after it. A part that starts with a marker, such as `- ` or `1. `, makes that
kind of block, and a fenced code block stays one code block. Pasting into a
code block keeps the text in it. A paste that would take the document past 600
blocks is refused whole, for example "This would add 5 blocks to a document of
598, and a document holds at most 600 blocks."

**Delete** asks "Delete this block? History keeps a copy." Select **Delete
this block** to go ahead, or **Keep it**. Deleting the last block leaves one
empty paragraph.

The handle and **Delete** appear when you point at or focus a block.

### Edit locks

Only one person types in a block at a time. Your first keystroke in a block
takes a lock on it; clicking, moving the caret and selecting text do not.
While you hold it, others see your initials and "_name_ is editing" on the
block, and cannot type in it, tick it, move it, join into it or delete it.
Screen readers announce the change. You hold one lock per document: typing in
another block releases the first.

The browser renews the lock while you type. It lets go about three seconds
after you leave the block and when you switch tabs, once your text is saved.
A lock that is not renewed lapses after about two minutes, and your next save
takes it back if nobody else has.

Your typing does not wait for the lock. If someone else got the block first,
or the block changed since your browser last saw it, the block goes back to
its current text and a notice says why, for example "Dana is editing this
block" or "This block changed since you last saw it". **Copy my draft** copies
what you typed; **Discard my draft** gives it up.

### What the models do

The models are told to keep the document current without being asked:
whenever something in the session is worth keeping, they add a short block in
the section it belongs to. They can write every kind of block, and are told to
leave a kind's marker out of the text: a to-do's text never starts with
`[ ]`. They can update and delete only blocks they wrote themselves, and tick
or untick only their own to-dos. To respond to anyone else's block, a model
comments on it. Models cannot move blocks.

When a model reads the document, each block shows its kind, whether a to-do is
ticked, and a numbered item's number, as in "todo (checked)" or
"numberedItem #2". Code is shown exactly as written; a divider has no text. A
block someone is typing in reads "being edited by _name_".

A model never takes a lock, and a model write is refused while a person is
editing that block. A model's update must name the version of the block it
read. If anyone changed the block since then, ticks included, nothing is
written; the model gets the current text and tick and is told to build on it
rather than undo the change. A model cannot delete one of its own blocks once
a person has edited it. Ticking a model's to-do counts as a person's edit.

## Comments

1. Select a passage of text in a block.
2. Select **Comment** beside the block's author.
3. Write your comment and select **Post comment** (or press Enter).

Selecting text takes no lock, so you can comment on a block someone else is
editing. A selection that spans two blocks offers no **Comment**.

Threads appear beside the document, in the order of their blocks. A block with
open threads shows "1 open thread" (or more). In browsers that support it, the
commented passages are highlighted.

Any open thread takes a **Reply**. Models also comment, but a model's comment
never calls anyone in.

### Asking a model

Type @ in a comment or reply to pick one of the room's models, for example
@Claude. The model reads the passage and the thread so far, and its answer is
posted as its reply in the thread, not in the agent chat. A mention runs as a
turn of its own once the model is free.

Under the comment, each mention shows where it stands:

- "waiting for _model_": queued until the model is free;
- "waiting for the runner": the runner is offline. The comment is saved, and
  the mention runs when the runner is back;
- "_model_ is answering";
- "_model_ replied";
- "_model_ could not reply": its turn failed or was stopped;
- "mention of _model_ cancelled".

### Settling threads

**Settle** closes a thread once it is dealt with. Settled threads move into
**Settled** at the bottom of the comments, folded and with a count; select it
to show them. **Reopen** brings one back. Only people settle or reopen threads.

### When the passage is gone

A thread follows its passage as the block changes. If the passage is edited
away or its block is deleted, the thread stays in the list marked "Passage
removed". **View original** shows the document as it stood just before the
change that removed it, with the commented block marked. If the passage comes
back, for example after a restore, the thread attaches to it again.

## The scribe

The scribe is one of the room's models, called in to reorganize the whole
document in one go: merging notes that overlap, cutting repetition and moving
blocks into the sections they belong in. It is told to keep each side of a
disagreement with whose view it is, and not to drop open questions.

Either person in the room can call it in.

1. Select **Call in the scribe** in the document header.
2. Choose which model acts as scribe.

It is refused, with the reason, while someone has typed in a block they still
hold ("_name_ is editing a block"), while that model is still answering a
message, while the runner is offline, and while a scribe is already working.
A lock nobody has typed under, such as a caret left in a block, does not stop
it: the run clears that lock, and that person's next keystroke is refused with
"The scribe is working on the document" and kept as a draft.

While the scribe works, a banner reads "The scribe is working", with the model,
who started it and how long it has run. The document is read-only for everyone:
nobody can edit, add, move, tick or delete blocks or restore a version, and the
models' own writes are refused. Selecting text and commenting keep working, for
people and models.
The scribe never edits files in the room's folder.

Its changes reach the document all at once when its turn ends, as one entry in
history. Blocks it did not touch stay exactly as they were, and a rewrite never
unticks a to-do. Comment threads
follow their passages into the rewritten blocks; a thread whose passage is gone
is marked "Passage removed".

**Stop** on the banner ends the run. Anyone in the room can stop it. A stopped
or failed run changes nothing. A run has at most 35 minutes. After that the
document unlocks and the run ends unchanged as "The scribe run ran out of
time".

When the run ends, the people who had the document open see how it went:

- "_model_ finished the scribe run. Its changes are one entry in history." with
  **See it in history**;
- "_model_ finished the scribe run without changing the document.";
- "_name_ stopped the scribe run. The document is unchanged.";
- "The scribe run failed: _reason_. The document is unchanged."

### Credits

A block the scribe writes is credited to the authors of the blocks it drew on,
for example "Scribe (Claude), from Robert, Ana". Credits come from those
blocks' authors, never from the scribe's own judgement. Blocks it only moves
keep their author.

A scribe block belongs to no model, so no model can update or delete it later;
models comment on it like anyone else's. People can edit it as usual.

## History and restore

**History** lists every change to the document, newest first:

- "Template seeding by _name_": the room's starting sections;
- "Edit by _name_": everything one person wrote in one block under one edit
  lock, or one split, join, change of kind, tick, move, paste or delete;
- "_model_'s turn": everything a model wrote in one turn;
- "Scribe run by _model_, started by _name_";
- "Restore by _name_".

**Load older versions** reaches further back. Select an entry to see the
document as it stood after it, read-only, with every kind, tick and number as
it was, and the blocks that change touched marked **Added**, **Changed**,
**Moved** or **Removed**. A tick or untick shows as **Changed**.

**Restore this version** returns every block to its text, kind, tick, place
and author in that version. Blocks deleted since come back; blocks added since are
removed. The current document is saved in history first, so nothing is lost,
and the whole restore is one new entry. Comment threads stay and follow the
restored text. Either person can restore. A restore is refused while someone
has typed in a block they still hold ("_name_ is editing a block") or the
scribe is working; a caret left in a block does not stop it.

## Templates

A new room's document starts from a template: a list of section headings, each
with optional guidance that appears as a paragraph under the heading. Atelier's
default has three sections and no guidance: "What's happened", "Ideas & notes"
and "Open questions".

Robert writes his own templates. On the web app's room list, select
**Templates**, then **New template**. Give it a **Template name**, fill in each
section's heading and guidance, use **Add section** for more, and select **Save
template**. **Edit** and **Delete** change or remove a template. Rooms already
made from a deleted template keep their documents.

**Save as template** in a room's document header saves that room's sections as
a new template, under the name you give it: its headings, and the template
guidance under them that nobody has changed. Nothing anyone wrote in the room
is copied.

### Creating a room on the web app

Robert can create rooms from the web app as well as from the phone. Select
**New room** on the room list and fill in:

- **Room name**;
- **Project folder**, where the room's agents work;
- **Template**: **Default**, or one of Robert's templates. **Edit templates**
  opens the templates page.

**Runner** shows the runner the room will use. With no runner online, the room
cannot be created. Select **Create room** to open it. A room created on the
phone always starts from the default template.

## What the agents see

- **The document and its comments are visible to every agent in the room.**
  Each turn starts with the document in its prompt: in full when it fits,
  otherwise as an outline with the agent's own blocks in full. A model
  continuing its session is shown what changed since its last turn. It can
  read the rest with its tools. The join notice tells teammates that the
  room document is shared with the agents and kept permanently. Deleting a
  block does not erase it: history keeps every version.
- **Team chat is not.** Nothing in an agent's prompt or document tools comes
  from team chat.
- **Independent reviews never receive the document and cannot write to it.**
  A review's prompt has no document, and its turns get no document tools.
- **Follow-ups to a review can read the document but never write to it.** They
  cannot add, change or delete blocks, or comment. Every follow-up runs on a
  session of its own kept with the review, even when Robert is alone in the
  room, so review content cannot later reach the document through the agent's
  ordinary session. See [shared rooms](shared-rooms.md#independent-reviews).

## Limits

The models work within caps for each turn:

- at most 20 block writes (each add, update or delete counts);
- at most 10 comments.

Everyone, people and models alike, works within the size of the document:

- at most 4,000 characters in a block (models also in a comment);
- no new blocks once the document has 600.

In the web app, typing stops at 4,000 characters, and a count such as "3,850 of
4,000 characters" appears once a block passes 3,800. At 600 blocks, Enter,
paste and the space below the last block add nothing, and a note says "A
document holds at most 600 blocks. Merge or remove some first." The scribe's
changes must also leave the document at 600 blocks or fewer. A write past a
cap is refused, and the model or person is told why. A comment's
quote must appear once in its block, so it lands where the model meant.
