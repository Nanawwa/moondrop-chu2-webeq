FROM nginx:alpine
# 只拷站点需要的文件，别把本地脚本带进镜像
COPY webapp/index.html webapp/styles.css /usr/share/nginx/html/
COPY webapp/js/ /usr/share/nginx/html/js/
COPY webapp/chu2-webeq.html /usr/share/nginx/html/
COPY webapp/deploy/nginx-docker.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
