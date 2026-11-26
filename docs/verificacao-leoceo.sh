NPM=nginx-proxy-manager-app-1
ANTICLONE_CONTAINERS=() # preencher somente se o inventário anterior identificar containers AntiClone no Docker compartilhado
id anticlone-dev
sudo -u anticlone-dev test -w /run/docker.sock && echo docker-socket-writable || echo docker-socket-not-writable
sudo ss -lntup
sudo nft list ruleset
sudo iptables-save
sudo ip6tables-save
sudo docker inspect --format '{{.Name}} image={{.Image}} user={{.Config.User}} privileged={{.HostConfig.Privileged}} capadd={{json .HostConfig.CapAdd}} security={{json .HostConfig.SecurityOpt}} memory={{.HostConfig.Memory}} cpu={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}} ports={{json .NetworkSettings.Ports}} networks={{json .NetworkSettings.Networks}} logdriver={{.HostConfig.LogConfig.Type}} mounts={{range .Mounts}}{{.Destination}}(rw={{.RW}}) {{end}}' "$NPM" "${ANTICLONE_CONTAINERS[@]}"
sudo docker exec "$NPM" nginx -T 2>&1 | awk '
  /^# configuration file / {selected=($0 ~ /(\/13\.conf|\/15\.conf|\/16\.conf|\/custom\/[^ ]+\.conf|anticlone[^ ]*\.conf):$/)}
  selected && /^[[:space:]]*(map|server_name|listen|include|location|limit_req_zone|limit_conn_zone|limit_req|limit_conn|limit_req_status|limit_conn_status|limit_req_dry_run|limit_conn_dry_run|client_max_body_size|set_real_ip_from|real_ip_header|real_ip_recursive|access_log|log_format|allow|deny|proxy_ssl_verify|proxy_ssl_server_name|proxy_pass_request_headers|proxy_cache|proxy_cache_key)[[:space:]]/ {print}
  selected && /^[[:space:]]*proxy_set_header[[:space:]]+(Host|X-Forwarded-For|X-Real-IP|CF-Connecting-IP|Origin|Referer)[[:space:]]/ {print}
  selected && /^[[:space:]]*[^#]*\$(server_name|realip_remote_addr|binary_remote_addr)/ && !/proxy_set_header/ {print}
'
sudo docker exec "$NPM" nginx -V 2>&1 | head -n 2
sudo stat -c '%A %U:%G %n' /run/docker.sock
sudo systemctl show user-1003.slice -p ControlGroup -p CPUQuotaPerSecUSec -p MemoryMax -p TasksMax
for cg in /sys/fs/cgroup /sys/fs/cgroup/user.slice /sys/fs/cgroup/user.slice/user-1003.slice; do
  for metric in cpu.max memory.max pids.max; do
    [ ! -r "$cg/$metric" ] || { printf '%s ' "$cg/$metric"; cat "$cg/$metric"; }
  done
done
sudo docker inspect --format 'driver={{.HostConfig.LogConfig.Type}} image={{.Image}}' "$NPM"
sudo df -hP
sudo df -iP
