#!/usr/bin/env node
// Stub for /usr/bin/shortcuts. Echoes its argv as JSON so tests can assert
// exactly what the process received — proving no shell touched it.
const argv = process.argv.slice(2);
if (argv[0] === "list") {
  process.stdout.write("Morning Routine\nEvening Routine\n");
} else {
  process.stdout.write(JSON.stringify(argv));
}
