# Talking to Makita on GitHub

Makita is the Hub's GitHub bot. Someone with the permission sets it up in Space settings → Makita.
On GitHub you steer it in your own words, in English or Spanish. The `/makita` commands keep
working as the exact form.

## Where Makita listens

- **On an issue**, mention it: `@<makita's login> stop`. Without the mention, Makita does not
  read your comment.
- **On Makita's own pull request**, no mention is needed: `stop` is enough.

Only people the configuration answers can steer it. Makita takes no order from anyone else.

## Short orders

A comment is an order when, without the mention, the punctuation, emoji and words like «please»
or «gracias», it is exactly one of these phrases. Capital letters and accents don't matter.

| To                        | Say, for example                                          | Exact form       |
| ------------------------- | --------------------------------------------------------- | ---------------- |
| Stop the work             | stop, cancel, abort, para, detente, alto, cancela, déjalo | `/makita stop`   |
| Try a failed task again   | retry, try again, reintenta, inténtalo de nuevo           | `/makita retry`  |
| Reopen an issue it closed | reopen, reopen it, reabre, reábrelo                       | `/makita reopen` |
| Send a push that waits    | ok, approved, go ahead, lgtm, dale, aprobado, súbelo      | `/makita ok`     |
| Merge its pull request    | merge, merge it, land it, mergéalo, fusiónalo             | `/makita merge`  |

A longer sentence is not an order, even when it contains one of these words: «stop using tabs» or
«no pares hasta que pase CI» reach Makita as normal conversation, and it answers.

## Who may approve and merge

- **Approving a push** («ok») and **merging** («merge it») count only from an approver: the
  configuration's creator and the approvers it lists. From anyone else they are conversation.
- «ok» counts only while a push waits and Makita already asked for it on the issue.
- A merge also needs CI to pass on the pull request's latest commit and GitHub to say it can merge.
- In longer words («vale, súbelo, ya lo revisé», «looks great, merge it»), Makita reads the
  comment, and the Hub checks it again on GitHub before it approves or merges anything.
- A review never approves a push or orders a merge. Say it in a comment.

## What is never an order

- A comment that was edited.
- A quoted line (`>`), text in an issue's description, or a comment by a bot or by Makita.
- A comment that also mentions someone else.
