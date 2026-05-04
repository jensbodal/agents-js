# Test hub plan fixture

This file is the hub-vault counterpart to the workspace memory file under
`.agents/test-agent/notes.md`. The probe query "memory rule about time
estimates" should surface a snippet from this file via searchDocs and a
matching snippet from notes.md via searchMemories — both with absolute
source_ref paths and confidence="responsible".

Time estimates are notoriously brittle; the rule is to size them by review
time rather than generation time.
