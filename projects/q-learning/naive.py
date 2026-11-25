import gymnasium as gym

env = gym.make("Taxi-v4", render_mode="human")
env.reset()

terminated = truncated = False
while not terminated and not truncated:
    _, _, terminated, truncated, _ = env.step(1)  # 1 = up (north)

env.close()