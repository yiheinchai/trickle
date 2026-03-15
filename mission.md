Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<general directive>
Make a big push of increasing the feature set of trickle to expand the target audience and the TAM. Make sure to update the readme and usecases accordingly.

Particularly, build for AI agents as the primary user.
</general directive>

<focus point>
Added Python database query tracing (sqlite3, psycopg2, pymysql, mysql.connector). Auto-patches drivers to capture SQL queries, timing, row counts, columns to .trickle/queries.jsonl. Works with the MCP server's get_database_queries tool.

Full agent observability stack now covers both JS and Python:
- Variables + types + sample values
- Function signatures + timing
- HTTP requests + status codes
- Console output
- Error context with nearby variables
- Database queries (JS: pg, mysql2, better-sqlite3 | Python: sqlite3, psycopg2, pymysql, redis, pymongo)

Added: Function execution timing (durationMs), Redis + MongoDB tracing, improved CLAUDE.md templates.

Database tracing now complete across both languages:
- JS: pg, mysql2, better-sqlite3, ioredis, mongoose
- Python: sqlite3, psycopg2, pymysql, mysql.connector, redis, pymongo

Done: Updated README with full agent observability stack, database tracing matrix, 9 MCP tools, architecture diagram.

Done: Call trace (calltrace.jsonl) with parent-child relationships + timing. 10 MCP tools now. Updated ai-agent.md with database debugging.

MCP server now has 10 tools:
get_runtime_context, get_annotated_source, get_function_signatures, get_errors,
get_database_queries, get_call_trace, get_console_output, get_http_requests,
check_data_freshness, refresh_runtime_data

Done: Python call trace with parent-child relationships + timing. Both JS and Python now write calltrace.jsonl.

Full agent observability stack is now feature-complete across both languages:
- Variables + types + sample values (JS + Python)
- Function signatures + execution timing (JS + Python)
- Call trace / execution flow (JS + Python)
- Database queries: SQL, Redis, MongoDB (JS + Python)
- HTTP requests + status codes (JS + Python)
- Console output (JS + Python)
- Error context with nearby variables (JS + Python)
- 10 MCP server tools

Next:
1. Test full agent debugging workflow on real project
2. Consider adding Go/Rust support for broader TAM
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

if you think everything has already be accomplished, please compact conversation, and work on improving trickle by your discretions
