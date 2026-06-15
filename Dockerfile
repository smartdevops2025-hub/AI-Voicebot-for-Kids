# Use the official Node.js 18 image as the base
FROM node:18-slim

# Set the working directory inside the container
WORKDIR /app

# Copy package files first (better for caching)
COPY package*.json ./

# Install all dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Tell Docker this container listens on port 7860
EXPOSE 7860

# Command to run when the container starts
CMD ["npm", "run", "start"]
