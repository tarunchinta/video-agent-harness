import random
import gymnasium as gym
import numpy as np

env = gym.make("Taxi-v4")

# Reset the environment to get initial state
state, info = env.reset()
print(f"Initial state: {state}")

alpha = 0.95 #learning rate (newer values are more important)
gamma = 0.99 #discount factor (how much future rewards are important)
epsilon = 1 #exploration rate (how often to explore) (will decrease over time)
epsilon_min = 0.01 #minimum exploration rate
epsilon_decay = 0.9999 #how much to decay epsilon over time
num_episodes = 2000

q_table = np.zeros([env.observation_space.n, env.action_space.n])
print(len(q_table))
print(len(q_table[0]))

def choose_action(state):
    if random.uniform(0, 1) < epsilon:
        return random.randint(0, 5)
    else:
        return np.argmax(q_table[state])

# Training

for episode in range(num_episodes):
    state, info = env.reset()
    terminated = False
    truncated = False

    while not terminated and not truncated: 

        # Action 1 = move right in Taxi-v3
        action = choose_action(state)
        next_state, reward, terminated, truncated, info = env.step(action)

        old_value = q_table[state, action]
        next_max = np.max(q_table[next_state])
        q_table[state, action] = ((1 - alpha) * old_value) + (alpha * (reward + gamma * next_max))
        state = next_state
        epsilon = max(epsilon_min, epsilon * epsilon_decay)
        if terminated or truncated:
            print("Episode ended early!")
            break

    print(f"Episode {episode + 1} completed!")

for i in range(len(q_table)):
    print(q_table[i])
    print("--------------------------------")
env.close()

# Testing
env = gym.make("Taxi-v4", render_mode="human")
state, info = env.reset()
print(f"Initial state: {state}")

terminated = False
truncated = False
step = 0
epsilon = 0

while not terminated and not truncated:

    # Action 1 = move right in Taxi-v3
    action = choose_action(state)
    next_state, reward, terminated, truncated, info = env.step(action)

    old_value = q_table[state, action]
    next_max = np.max(q_table[next_state])
    q_table[state, action] = ((1 - alpha) * old_value) + (alpha * (reward + gamma * next_max))
    epsilon = max(epsilon_min, epsilon * epsilon_decay)
    state = next_state

    # Render the environment to visualize the movement
    env.render()
    print(f"Step {step + 1}: Action={action}, State={state}, Reward={reward}")
    print(terminated, truncated)
    if terminated or truncated:
        print("Episode ended early!")
        break

    step += 1

print(f"Total steps: {step}")
print(f"Total reward: {reward}")
env.close()
