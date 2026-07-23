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

// WithoutRenderOperator removes a terminal Kusto-style render stage. Rendering
// is a Vesta user-agent concern; VictoriaLogs should only receive LogsQL.
func WithoutRenderOperator(query string) string {
	pipe := lastTopLevelPipe(query)
	if pipe < 0 {
		return query
	}
	stage := strings.TrimSpace(stripCommentsAndStrings(query[pipe+1:]))
	fields := strings.Fields(stage)
	if len(fields) < 2 || !strings.EqualFold(fields[0], "render") {
		return query
	}
	return strings.TrimRight(query[:pipe], " \t\r\n")
}

func lastTopLevelPipe(query string) int {
	pipe := -1
	var quote byte
	comment := false
	for i := 0; i < len(query); i++ {
		switch {
		case comment:
			if query[i] == '\n' {
				comment = false
			}
		case quote != 0:
			if query[i] == '\\' {
				i++
			} else if query[i] == quote {
				quote = 0
			}
		case query[i] == '#':
			comment = true
		case query[i] == '"' || query[i] == '\'':
			quote = query[i]
		case query[i] == '|':
			pipe = i
		}
	}
	return pipe
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
