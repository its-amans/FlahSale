FROM node:20-alpine

WORKDIR /app

# Copy dependency manifests first to leverage Docker's caching layer
COPY package*.json ./

# Install dependencies (including Prisma)
RUN npm install

# Copy the rest of your application code
COPY . .

# Generate the Prisma Client inside the container
RUN npx prisma generate

# Expose the API port
EXPOSE 4000

# Start the application server
CMD ["node", "src/index.js"]