# Authority and capabilities

What ANOMANDER can do, with what permission, and which operations follow from the ontology.

## Authority boundaries

Four levels. I set the level of each operation; the model can neither raise nor lower it.

| Level | What it allows | Who decides each case | Examples in the workflow |
| --- | --- | --- | --- |
| Free | Read, observe, infer, propose | Nobody: nothing outside ANOMANDER changes | Read the receipt; propose a category |
| With permission | Actions covered by an active permission, within its limits | The code checks the permission | Register an expense if the lines add up to the total; send me the Sunday summary |
| With confirmation | Change or delete something of mine, contact third parties, any action no permission covers | Me, case by case | Register a receipt that does not add up; correct or delete an expense |
| Forbidden | Move money, grant permissions, act on my behalf towards others | Nobody: the operation does not exist | Pay, transfer, file a complaint with a merchant |

**Why confidence is not permission.** Confidence answers "is it true?"; permission answers "may you do it?". They are different questions. That is why the permission to register without asking does not say "if you are sure" but "if the lines add up to the total": a condition the code checks, not a feeling of the model. Confidence decides whether ANOMANDER proposes; permission decides whether it acts.

And what is forbidden is not a rule the model has to respect: it is an operation that does not exist. If there is no "pay" capability, there is no way for the model to invent one.

## Capabilities and operations

Seven capabilities are enough to close the expenses workflow. Each operation states which kind of truth it produces and at which authority level it runs. None of them names a model, an app or a bank.

| Capability | Operation | Input | Output | Level |
| --- | --- | --- | --- | --- |
| Understand the principal | Interpret a message | Text from me ("23 € cena") | The literal declaration, plus a proposed amount, merchant and category | Free |
| Read documents | Extract data from a receipt | A receipt photo | Inferences: merchant, date, lines, total, payment method | Free |
| Classify expenses | Assign a category | A proposed expense, my categories and my policies | The category: derived from one of my policies, or inferred | Free |
| Consult the principal | Raise a decision | A question and its options | Pending decision; my answer comes back as a declaration or confirmation | Free |
| Register expenses | Register, correct or delete an expense | A proposal | The expense in my ledger, with its mode and provenance | Register: with permission if it adds up, with confirmation if not. Correct and delete: with confirmation |
| Inform the principal | Send a summary or a notice | The expenses of a period | Action, then an observation of whether it was delivered | With permission |
| Manage matters | Open, pause or close a matter | My declaration or a proposal from ANOMANDER | A change in the matter's state | With confirmation if ANOMANDER proposes it |

Three internal operations are not capabilities because nobody asks for them, and all three are deterministic code: **check consistency** (the lines add up to the total, the date is valid, it is not a duplicate of an expense already registered), **check authority** (decides whether a proposal is executed, asked about or discarded) and **retain** (decides what survives when an execution ends).

Note what is missing: there is no "pay" and no "transfer". That is why moving money is forbidden without having to ask the model not to do it.
