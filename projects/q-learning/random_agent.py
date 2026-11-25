import gymnasium as gym

env = gym.make("Taxi-v4")
env.reset()

returns = []
for ep in range(1000):
    state, _ = env.reset()
    total, done = 0, False
    while not done:
        state, r, terminated, truncated, _ = env.step(env.action_space.sample())
        total += r
        done = terminated or truncated
    returns.append(total)

print(f"Average score: {sum(returns) / len(returns)}")
