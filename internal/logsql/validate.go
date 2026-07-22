package logsql

import "strings"

// HasTimeFilter recognizes an actual LogsQL _time: filter while ignoring
// quoted strings and # line comments. VictoriaLogs accepts filters at any
// level, so this intentionally checks presence rather than query position.
func HasTimeFilter(query string) bool {
	for i := 0; i < len(query); {
		switch query[i] {
		case '#':
			for i < len(query) && query[i] != '\n' {
				i++
			}
		case '"', '\'':
			quote := query[i]
			i++
			for i < len(query) {
				if query[i] == '\\' {
					i += 2
					continue
				}
				if i < len(query) && query[i] == quote {
					i++
					break
				}
				i++
			}
		default:
			if isIdentStart(query[i]) {
				start := i
				for i < len(query) && isIdent(query[i]) {
					i++
				}
				if query[start:i] != "_time" {
					continue
				}
				for i < len(query) && strings.ContainsRune(" \t\r\n", rune(query[i])) {
					i++
				}
				if i < len(query) && query[i] == ':' {
					return true
				}
				continue
			}
			i++
		}
	}
	return false
}

func isIdentStart(c byte) bool { return c == '_' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' }
func isIdent(c byte) bool      { return isIdentStart(c) || c >= '0' && c <= '9' || c == '.' }

func LooksUnbounded(query string) bool {
	clean := stripCommentsAndStrings(query)
	return strings.Contains(clean, "_time:>") || strings.Contains(clean, "_time:day_range") || strings.Contains(clean, "_time:week_range")
}

func stripCommentsAndStrings(query string) string {
	var out strings.Builder
	for i := 0; i < len(query); {
		if query[i] == '#' {
			for i < len(query) && query[i] != '\n' {
				i++
			}
			continue
		}
		if query[i] == '"' || query[i] == '\'' {
			quote := query[i]
			i++
			for i < len(query) {
				if query[i] == '\\' {
					i += 2
					continue
				}
				if i < len(query) && query[i] == quote {
					i++
					break
				}
				i++
			}
			out.WriteByte(' ')
			continue
		}
		out.WriteByte(query[i])
		i++
	}
	return out.String()
}
