package auth

import "context"

type contextKey struct{}

func WithUser(ctx context.Context, user User) context.Context {
	return context.WithValue(ctx, contextKey{}, user)
}

func MustUser(ctx context.Context) User {
	user, ok := ctx.Value(contextKey{}).(User)
	if !ok {
		panic("authenticated user missing from context")
	}
	return user
}
