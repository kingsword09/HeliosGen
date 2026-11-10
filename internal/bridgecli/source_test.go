package bridgecli

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestAttachSource(test *testing.T) {
	cases := []struct {
		name    string
		input   string
		session string
		block   string
		want    any
	}{
		{name: "unknown agent", input: `{}`, want: map[string]any{"name": "agent"}},
		{name: "Rex environment", input: `{}`, session: "session", block: "block", want: map[string]any{"name": "rex", "rexSessionId": "session", "rexBlockId": "block"}},
		{name: "reported agent", input: `{"source":{"name":"codex"}}`, want: map[string]any{"name": "codex"}},
		{name: "agent inside Rex", input: `{"source":{"name":"codex"}}`, session: "session", block: "block", want: map[string]any{"name": "codex", "rexSessionId": "session", "rexBlockId": "block"}},
		{name: "empty source", input: `{"source":{}}`, session: "session", want: map[string]any{"name": "rex", "rexSessionId": "session", "rexBlockId": ""}},
		{name: "blank name", input: `{"source":{"name":"  "}}`, want: map[string]any{"name": "agent"}},
		{name: "preserve explicit context", input: `{"source":{"name":"claude-code","rexSessionId":"original","rexBlockId":"original-block"}}`, session: "session", block: "block", want: map[string]any{"name": "claude-code", "rexSessionId": "original", "rexBlockId": "original-block"}},
		{name: "never mix contexts", input: `{"source":{"name":"codex","rexSessionId":"original"}}`, session: "session", block: "block", want: map[string]any{"name": "codex", "rexSessionId": "original"}},
		{name: "complete matching context", input: `{"source":{"name":"codex","rexSessionId":"session"}}`, session: "session", block: "block", want: map[string]any{"name": "codex", "rexSessionId": "session", "rexBlockId": "block"}},
		{name: "invalid source rejected downstream", input: `{"source":"invalid"}`, want: "invalid"},
		{name: "invalid name rejected downstream", input: `{"source":{"name":123}}`, want: map[string]any{"name": float64(123)}},
	}
	for _, scenario := range cases {
		test.Run(scenario.name, func(test *testing.T) {
			var request map[string]any
			if err := json.Unmarshal([]byte(scenario.input), &request); err != nil {
				test.Fatal(err)
			}
			attachSource(request, scenario.session, scenario.block)
			if !reflect.DeepEqual(request["source"], scenario.want) {
				test.Fatalf("source = %#v, want %#v", request["source"], scenario.want)
			}
		})
	}
}
