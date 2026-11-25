# Remember the reward each action gave in each state, then always pick the best one.
import gymnasium as gym
import numpy as np

env = gym.make("Taxi-v4")
rewards = np.zeros([env.observation_space.n, env.action_space.n])

# Explore: act randomly and write down every reward
for episode in range(1000):
    state, _ = env.reset()
    terminated = truncated = False
    while not terminated and not truncated:
        action = env.action_space.sample()
        next_state, reward, terminated, truncated, _ = env.step(action)
        rewards[state, action] = reward
        state = next_state

# Play: always pick the action with the best reward
env = gym.make("Taxi-v4", render_mode="human")
state, _ = env.reset()
terminated = truncated = False
while not terminated and not truncated:
    print(rewards[state])
    action = np.argmax(rewards[state])
    state, _, terminated, truncated, _ = env.step(action)

env.close()
