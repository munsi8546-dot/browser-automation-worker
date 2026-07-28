# প্লে-রাইটের লেটেস্ট ১.৬২.০ ইমেজ ব্যবহার করছি যা প্যাকেজের সাথে পুরোপুরি মিলবে
FROM mcr.microsoft.com/playwright:v1.62.0-jammy

# অ্যাপ ডিরেক্টরি তৈরি
WORKDIR /usr/src/app

# প্যাকেজ ফাইল কপি এবং ইনস্টল
COPY package*.json ./
RUN npm install

# অ্যাপের বাকি কোড কপি
COPY . .

# পোর্ট সেটআপ
EXPOSE 10000

# সার্ভার চালু করার কমান্ড
CMD [ "node", "server.js" ]
