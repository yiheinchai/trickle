"""End-to-end test for the Python trickle client."""
import sys
sys.path.insert(0, 'packages/client-python/src')

from trickle import trickle, configure

configure(backend_url='http://localhost:4888', batch_interval=0.5)


@trickle
def process_order(order):
    total = sum(item['price'] * item['quantity'] for item in order['items'])
    tax = total * 0.1
    return {
        'order_id': order['id'],
        'customer': order['customer']['name'],
        'total': total,
        'tax': tax,
        'grand_total': total + tax,
        'status': 'processed',
    }


@trickle
def validate_payment(payment):
    if not payment.get('card_number'):
        raise ValueError('Card number is required')
    if payment['amount'] <= 0:
        raise TypeError('Amount must be positive')
    return {'valid': True, 'method': payment['method']}


@trickle
def get_user(user_id, include_roles=False):
    return {
        'id': user_id,
        'name': 'Jane Smith',
        'email': 'jane@example.com',
        'roles': ['admin', 'editor'] if include_roles else [],
        'metadata': {
            'last_login': '2026-03-10T10:00:00Z',
            'login_count': 99,
        },
    }


def main():
    import time

    print('=== Running Python instrumented functions ===\n')

    print('1. process_order (happy path)')
    result = process_order({
        'id': 'ORD-789',
        'customer': {'name': 'Bob', 'email': 'bob@example.com'},
        'items': [
            {'name': 'Book', 'price': 15.99, 'quantity': 3},
            {'name': 'Pen', 'price': 2.50, 'quantity': 10},
        ],
    })
    print(f'   Result: {result}')

    print('2. get_user (happy path)')
    user = get_user('usr-101', include_roles=True)
    print(f'   Result: {user}')

    print('3. validate_payment (error: missing card)')
    try:
        validate_payment({'amount': 100, 'method': 'credit'})
    except ValueError as e:
        print(f'   Caught: {e}')

    print('4. validate_payment (error: bad amount)')
    try:
        validate_payment({'card_number': '5500000000000004', 'amount': -10, 'method': 'debit'})
    except TypeError as e:
        print(f'   Caught: {e}')

    print('5. validate_payment (happy path)')
    result = validate_payment({'card_number': '5500000000000004', 'amount': 75, 'method': 'debit'})
    print(f'   Result: {result}')

    print('\nWaiting for flush...')
    time.sleep(3)
    print('Done!')


if __name__ == '__main__':
    main()
