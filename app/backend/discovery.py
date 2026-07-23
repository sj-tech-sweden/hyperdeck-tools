import asyncio
import ipaddress
import socket

import psutil


def get_active_interface_network():
    """
    Finds the primary active network interface that routes traffic out,
    and returns its corresponding ipaddress.IPv4Network object.
    Defaults to 192.168.1.0/24 if it can't determine it reliably.
    """
    local_ip = "127.0.0.1"
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
    except Exception:
        local_ip = "127.0.0.1"
    finally:
        if s:
            try:
                s.close()
            except Exception:
                pass

    interfaces = psutil.net_if_addrs()
    for interface_name, addrs in interfaces.items():
        for addr in addrs:
            if addr.family == socket.AF_INET and addr.address == local_ip:
                return ipaddress.IPv4Interface(f"{local_ip}/{addr.netmask}").network

    return ipaddress.IPv4Network("192.168.1.0/24")

async def check_hyperdeck_port(ip, port=9993, timeout=0.5):
    """
    Attempts to open a quick TCP handshake on the HyperDeck control port.
    """
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(str(ip), port),
            timeout=timeout
        )
        writer.close()
        await writer.wait_closed()
        return str(ip)
    except (asyncio.TimeoutError, ConnectionRefusedError, OSError):
        return None

async def scan_network_worker(queue, results, semaphore):
    """
    Worker task that pulls IPs from the queue and checks them.
    """
    async with semaphore:
        while True:
            try:
                ip = queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            found_ip = await check_hyperdeck_port(ip)
            if found_ip:
                results.append(found_ip)
            queue.task_done()

async def discover_hyperdecks():
    network = get_active_interface_network()

    queue = asyncio.Queue()
    for host in network.hosts():
        await queue.put(host)

    results = []

    max_concurrent_tasks = 150
    semaphore = asyncio.Semaphore(max_concurrent_tasks)

    num_workers = min(max_concurrent_tasks, network.num_addresses)
    workers = [
        asyncio.create_task(scan_network_worker(queue, results, semaphore))
        for _ in range(num_workers)
    ]

    await queue.join()

    for worker in workers:
        worker.cancel()

    return {
        "subnet_scanned": str(network),
        "found": results
    }
