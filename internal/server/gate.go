package server

import "sync"

type concurrencyGate struct {
	mu      sync.Mutex
	queries map[string]int
	maxQ    int
}

func newConcurrencyGate(maxQueries int) *concurrencyGate {
	return &concurrencyGate{queries: map[string]int{}, maxQ: maxQueries}
}

func (g *concurrencyGate) acquire(subject string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.queries[subject] >= g.maxQ {
		return false
	}
	g.queries[subject]++
	return true
}

func (g *concurrencyGate) release(subject string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.queries[subject] <= 1 {
		delete(g.queries, subject)
		return
	}
	g.queries[subject]--
}
