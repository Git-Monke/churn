# Agent instructions

## Code review and commits

- Do not commit changes until the user explicitly approves them.
- Leave completed changes in the working tree for review.
- Run tests, formatting, and builds as usual, but stop before `git commit`.
- Only create, amend, or squash commits after the user approves the changes.

If the agent asks for anything related to beans, run the `beans prime` command and heed its output.

When the user mentions beans and asks for a plan, write the plan inside of the relevant existing bean. If no bean exists, create one and write the plan there. If the user has not mentioned beans, just write the plans into the chat
